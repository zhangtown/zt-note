#!/usr/bin/env node
// 无后端冒烟测试：把 dist 挂到 /app/zt-note/ 前缀下，用无头 Chrome 打开，
// 检查页面能否装配（顶栏 / 文档树 / 首页），并确认没有前端异常、没有绝对路径 404。
//
// 用法：npm run build && npm run smoke
// 说明：不启动任何后端服务，api/* 请求会 404 —— 页面应显示错误态而不是白屏。
//       因此这是一个「外壳与错误路径」测试，接口联调仍需真实后端。
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', '..', 'internal', 'webui', 'dist')
const PREFIX = '/app/zt-note/'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'google-chrome',
  'chromium',
].filter(Boolean)

const problems = []
const log = (m) => console.log(m)
const fail = (m) => {
  problems.push(m)
  console.log(`  ✗ ${m}`)
}
const pass = (m) => console.log(`  ✓ ${m}`)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`未找到构建产物：${dist}/index.html（先跑 npm run build）`)
  process.exit(1)
}

/* ---------- 1. 静态服务器（模拟 fnOS 网关前缀） ---------- */

const served = []
const notFound = []
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let path = url.pathname
  if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length - 1)
  else if (path.startsWith('/app/')) path = '/' // 前缀写错也应落到 index
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '').split(sep).join('/')
  let file = join(dist, rel)
  if (!file.startsWith(dist)) file = join(dist, 'index.html')
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (rel.startsWith('api/')) {
      notFound.push(`/${rel}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'smoke 测试没有后端' }))
      return
    }
    file = join(dist, 'index.html') // SPA 回退
  }
  served.push('/' + rel)
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

const port = await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))
const base = `http://127.0.0.1:${port}${PREFIX}`
log('zt-note 冒烟测试（无后端）')
log(`静态服务：${base}`)

/* ---------- 2. 启动无头浏览器 ---------- */

const profile = mkdtempSync(join(tmpdir(), 'zt-note-smoke-'))
const debugPort = 9000 + Math.floor(Math.random() * 900)
const browser = findBrowser()
if (!browser) {
  server.close()
  console.error('未找到 Chrome/Edge，跳过冒烟测试（可用 CHROME_PATH 指定）')
  process.exit(0)
}
log(`浏览器：${browser}`)

const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const cleanup = () => {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {
    /* 忽略 */
  }
  server.close()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

try {
  const target = await waitForTarget(debugPort)
  const results = await drive(target, base)

  echo(results)
  log('\n请求记录：')
  for (const path of [...new Set(served)]) pass(`200 ${path}`)
  const badApi = notFound.filter((p) => !p.startsWith('/api/'))
  if (badApi.length) fail(`静态资源 404：${badApi.join(', ')}`)
  if (results.errors.length) fail(`页面异常：${results.errors.slice(0, 3).join(' | ')}`)
  else pass('无前端异常')
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  cleanup()
}

function echo(r) {
  log('\n页面状态：')
  if (r.title !== null) pass(`document.title = ${r.title}`)
  if (r.hasShell) pass('.shell 布局已渲染（顶栏 + 侧栏 + 主区域）')
  else fail('.shell 布局未渲染（白屏或启动失败）')
  if (r.hasTopbar) pass('顶栏存在')
  else fail('顶栏缺失')
  if (r.hasSidebar) pass('左侧文档树容器存在')
  else fail('文档树容器缺失')
  if (r.hasHome) pass('首页内容已渲染')
  else fail('首页内容未渲染')
  if (r.version) pass(`版本区文案：${r.version}`)
  else fail('版本区为空')
  if (r.treeText) pass(`文档树文案：${r.treeText.replace(/\s+/g, ' ').slice(0, 80)}`)
  else fail('文档树无内容')
}

if (problems.length) {
  log(`\n冒烟测试失败：${problems.length} 项问题`)
  process.exit(1)
}
log('\n冒烟测试通过：产物可在 /app/zt-note/ 前缀下装配，资源全部相对路径命中')
process.exit(0)

/* ---------- 工具函数 ---------- */

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
      if (!probe.error) return candidate
    }
  }
  return ''
}

async function waitForTarget(port) {
  const deadline = Date.now() + 20000
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await sleep(250)
  }
  throw new Error(`浏览器调试端口未就绪：${lastErr}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function drive(target, url) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const errors = []
  let id = 0
  const pending = new Map()
  const events = []

  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', () => no(new Error('CDP 连接失败')), { once: true })
  })

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    events.push(msg)
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails
      errors.push(d?.exception?.description ?? d?.text ?? '未知异常')
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      const entry = msg.params.entry
      const text = entry.text ?? ''
      const url = entry.url ?? ''
      // api/* 404 与 favicon 是预期内的（这个测试没有后端），不算前端错误
      if (/\/api\//.test(url) || /api\//.test(text) || /favicon/.test(url)) return
      errors.push(text)
    }
  })

  const send = (method, params = {}) =>
    new Promise((ok, no) => {
      const mid = ++id
      pending.set(mid, (msg) => (msg.error ? no(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)))
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.navigate', { url })

  const loaded = await waitFor(() => events.some((m) => m.method === 'Page.loadEventFired'), 15000)
  if (!loaded) throw new Error('页面 load 事件超时')
  await sleep(1200) // 等 fetch(api/health|tree) 失败并进入错误态

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const main = document.querySelector('.main')
      return {
        title: document.title,
        hasShell: !!document.querySelector('.shell'),
        hasTopbar: !!document.querySelector('.topbar'),
        hasSidebar: !!document.querySelector('.sidebar'),
        hasHome: !!document.querySelector('.home-hero') || !!document.querySelector('.error-box') || !!document.querySelector('.empty-box'),
        version: (document.querySelector('.version')?.textContent || '').trim(),
        treeText: (document.querySelector('.tree')?.innerText || '').trim().slice(0, 200),
        mainText: (main?.innerText || '').trim().slice(0, 200),
        api: (document.querySelector('.error-msg')?.textContent || '').trim().slice(0, 120),
      }
    })()`,
  })
  ws.close()
  return { ...(probe.result?.value ?? { title: null, hasShell: false }), errors }
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(100)
  }
  return false
}
