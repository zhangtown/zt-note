#!/usr/bin/env node
// zt-note 真实端到端联调测试：真实 Go 后端（.test/ztnote.exe）+ 无头 Chrome（CDP）
//
// 与前端的 smoke.mjs 不同，本脚本不起静态服务器，而是启动真实后端（含 go:embed 前端产物），
// 在 /app/zt-note 前缀下打开页面，用真实鼠标/键盘事件走完：
//   导入真实笔记 → 文档树 → 阅读渲染 → 编辑 → 保存 → 磁盘校验 → 无改动保存字节保真
//   → 搜索 → 导出 zip 比对
//
// 用法：node ui/scripts/e2e-live.mjs [--build] [--keep-ws] [--keep-server]
//   --build        强制重新构建 .test/ztnote.exe
//   --keep-ws      不删除 .test/uiws（默认每次重建，保证幂等）
//   --keep-server  结束后保留后端进程（默认杀掉）
//
// 只读产品代码，不修改 ui/src、internal、cmd。发现的问题写进 ui/E2E-LIVE-REPORT.md。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

/* ================= 配置 ================= */

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..', '..')
const TEST = join(ROOT, '.test')
const EXE = join(TEST, 'ztnote.exe')
const WS = join(TEST, 'uiws')
// 应用侧改成「一人一份工作区」：数据根 .test/uiws/users/<uid>/workspace。
// 不带网关身份头时身份是 local，所以磁盘校验都指向 USER_WS。
const USER = 'local'
const USER_WS = join(WS, 'users', USER, 'workspace')
const SHOTS = join(TEST, 'e2e-live-shots')
const SERVER_LOG = join(TEST, 'e2e-live-server.log')
const REPORT = join(ROOT, 'ui', 'E2E-LIVE-REPORT.md')
const EXPORT_ZIP = join(TEST, 'e2e-live-export-siyuan.zip')
const EXPORT_MD_ZIP = join(TEST, 'e2e-live-export-md.zip')

const HOST = '127.0.0.1'
const PORT = 8801
const SHIM_PORT = 8802
const PREFIX = '/app/zt-note'
const BASE = `http://${HOST}:${PORT}`
const APP_URL = `${BASE}${PREFIX}/`
const API = `${BASE}${PREFIX}/api`
const DIST = join(ROOT, 'internal', 'webui', 'dist')
const SHIM_BASE = `http://${HOST}:${SHIM_PORT}`
const SHIM_URL = `${SHIM_BASE}${PREFIX}/`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

const SIYUAN_DATA = 'C:/Users/USER/Documents/kimi/Workspaces/示例工作区/data'
const EXPECT_STATS = { notebooks: 2, docs: 12, blocks: 227, assets: 22 }
// 第一次进入会白送一个「我的笔记」+ 一篇欢迎文档，盘点时要算进去
const WELCOME_BOX = '我的笔记'
const EXPECT_BOXES = EXPECT_STATS.notebooks + 1
const EXPECT_DOCS = EXPECT_STATS.docs + 1
const TEST_PIN = '135790'
const DOC_TITLE = '示例文档'
const READ_TEXT = ['正文片段', '示例数值']

const argv = new Set(process.argv.slice(2))
const FORCE_BUILD = argv.has('--build')
const KEEP_WS = argv.has('--keep-ws')
const KEEP_SERVER = argv.has('--keep-server')

const NEW_TEXT = `E2E-联调-${Date.now()}`

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'google-chrome',
  'chromium',
].filter(Boolean)

/* ================= 记录器 ================= */

const checks = []
const bugs = []
const warnings = []
const stdout = []

/** 当前断言所处模式：strict=只用真实二进制；shim=静态资源由测试代理代答（绕开已知阻塞 bug） */
let MODE = 'strict'

const log = (msg) => {
  stdout.push(msg)
  console.log(msg)
}

function check(group, name, ok, detail = '') {
  const item = { group, name, ok: Boolean(ok), detail: String(detail ?? ''), mode: MODE }
  checks.push(item)
  log(`  ${item.ok ? '✓' : '✗'} [${group}] ${name}${detail ? ` — ${detail}` : ''}`)
  return item.ok
}

function skip(group, name, detail = '前置步骤失败，跳过') {
  checks.push({ group, name, ok: false, skipped: true, detail, mode: MODE })
  log(`  ⊘ [${group}] ${name} — ${detail}`)
  return false
}

function bug(title, symptom, repro, expected, actual, files, hint = '') {
  bugs.push({ title, symptom, repro, expected, actual, files, hint })
  log(`  ! BUG/不一致：${title}`)
}

function warn(msg) {
  warnings.push(msg)
  log(`  ~ ${msg}`)
}

/* ================= HTTP 工具 ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 会话 Cookie：PIN 解锁后后端发一枚 HttpOnly Cookie，后续请求必须带上。
// 这里手动维护，好处是能顺便验证「不带 Cookie 就是 401」。
let COOKIE = ''

function withCookie(init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (COOKIE) headers.Cookie = COOKIE
  return { ...init, headers }
}

function captureCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const raw = list.length ? list : [res.headers.get('set-cookie') ?? '']
  for (const c of raw) {
    const m = /(ztnote_session=[^;]*)/.exec(c)
    if (!m) continue
    COOKIE = /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c) ? '' : m[1]
  }
}

async function httpJson(url, init) {
  const res = await fetch(url, withCookie(init))
  captureCookie(res)
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { status: res.status, ok: res.ok, data, text }
}

async function getJson(url) {
  const r = await httpJson(url, { headers: { Accept: 'application/json' } })
  if (!r.ok || (r.data && r.data.ok === false)) throw new Error(`GET ${url} → HTTP ${r.status}: ${r.text.slice(0, 200)}`)
  return r.data
}

async function postJson(url, body) {
  const r = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return r
}

async function probeHealth() {
  try {
    const res = await fetch(`${BASE}${PREFIX}/api/health`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/* ================= 构建 & 服务进程 ================= */

function newestMtime(dir, ignore = new Set(['node_modules', '.git', '.test', 'dist'])) {
  let newest = 0
  const walk = (d, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (ignore.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else {
        try {
          const m = statSync(p).mtimeMs
          if (m > newest) newest = m
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  walk(dir, 0)
  return newest
}

function resolveGo() {
  const candidates = ['C:/Users/USER/go-sdk/go/bin/go.exe', 'C:/Users/USER/go-sdk/go/bin/go']
  for (const c of candidates) if (existsSync(c)) return c
  return 'go'
}

function needsBuild() {
  if (!existsSync(EXE)) return '二进制不存在'
  const exeTime = statSync(EXE).mtimeMs
  const srcs = [
    join(ROOT, 'cmd'),
    join(ROOT, 'internal'),
    join(ROOT, 'ui', 'src'),
    join(ROOT, 'ui', 'index.html'),
  ]
  for (const s of srcs) {
    const t = existsSync(s) ? (statSync(s).isDirectory() ? newestMtime(s) : statSync(s).mtimeMs) : 0
    if (t > exeTime) return `${s} 比二进制新`
  }
  return ''
}

function buildBackend() {
  const reason = FORCE_BUILD ? '--build 指定' : needsBuild()
  if (!reason) {
    check('1-构建', '复用已有 .test/ztnote.exe（源与产物均未变新）', true, EXE)
    return
  }
  log(`  构建后端（原因：${reason}）…`)
  const go = resolveGo()
  const env = { ...process.env }
  env.PATH = `C:/Users/USER/go-sdk/go/bin;${env.PATH ?? ''}`
  const t0 = Date.now()
  const r = spawnSync(go, ['build', '-o', EXE, './cmd/ztnote'], { cwd: ROOT, env, encoding: 'utf8' })
  if (r.status !== 0) {
    check('1-构建', 'go build -o .test/ztnote.exe ./cmd/ztnote', false, (r.stderr || r.stdout || r.error?.message || '').slice(0, 600))
    throw new Error('后端构建失败')
  }
  check('1-构建', 'go build -o .test/ztnote.exe ./cmd/ztnote', true, `${((Date.now() - t0) / 1000).toFixed(1)}s，${(statSync(EXE).size / 1048576).toFixed(1)}MB`)
}

let serverProc = null

async function startServer() {
  if (!KEEP_WS) rmSync(WS, { recursive: true, force: true })
  mkdirSync(TEST, { recursive: true })
  const busy = await probeHealth()
  if (busy) throw new Error(`端口 ${PORT} 已被占用（health: ${JSON.stringify(busy).slice(0, 200)}），请先停止该进程`)

  const fd = openSync(SERVER_LOG, 'w')
  serverProc = spawn(EXE, ['-data', WS, '-addr', `${HOST}:${PORT}`, '-prefix', PREFIX], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  serverProc.on('exit', (code, sig) => {
    if (!KEEP_SERVER && code !== 0 && code !== null) log(`  ~ 后端进程提前退出：code=${code} sig=${sig}`)
  })

  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const h = await probeHealth()
    if (h?.ok) {
      await sleep(150)
      return h
    }
    await sleep(200)
  }
  throw new Error(`后端 30s 未就绪。日志尾部：\n${tail(SERVER_LOG, 12)}`)
}

function tail(file, lines) {
  try {
    const all = readFileSync(file, 'utf8').trim().split('\n')
    return all.slice(-lines).join('\n')
  } catch {
    return '(无日志)'
  }
}

function killServer() {
  if (!serverProc && !KEEP_SERVER) return
  if (serverProc && !serverProc.killed) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(serverProc.pid), '/t', '/f'], { stdio: 'ignore' })
      else serverProc.kill('SIGTERM')
    } catch {
      /* 忽略 */
    }
  }
}

/* ================= 测试代理（仅用于绕开已发现的静态资源冲突） =================
 * 真实二进制在 /assets/ 上挂了「data/assets 数据资源」路由，把前端产物自己的
 * assets/index-*.js|css 全部吃掉（404 JSON），页面无法装配。
 * 这个代理只代答“前端产物静态文件”，api/* 与笔记图片资源仍旧转发给真实后端，
 * 用于在报告里验证编辑/保存/磁盘保真/搜索/导出链路。不改任何产品代码。 */

let shimServer = null

function startShim() {
  return new Promise((resolvePromise, reject) => {
    shimServer = createServer((req, res) => {
      void handleShim(req, res)
    })
    shimServer.once('error', reject)
    shimServer.listen(SHIM_PORT, HOST, () => resolvePromise(shimServer))
  })
}

function serveDistFile(res, file) {
  if (!file.startsWith(DIST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('越界路径')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function proxyToBackend(req, res, url) {
  const preq = httpRequest(
    {
      host: HOST,
      port: PORT,
      method: req.method,
      path: url.pathname + url.search,
      headers: { ...req.headers, host: `${HOST}:${PORT}` },
    },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers)
      pres.pipe(res)
    },
  )
  preq.on('error', (err) => {
    try {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`代理到真实后端失败：${err.message}`)
    } catch {
      /* 忽略 */
    }
  })
  req.pipe(preq)
}

async function handleShim(req, res) {
  try {
    const url = new URL(req.url ?? '/', SHIM_BASE)
    const p = url.pathname
    if (p === PREFIX) {
      res.writeHead(302, { Location: `${PREFIX}/` })
      res.end()
      return
    }
    if (!p.startsWith(`${PREFIX}/`)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"error":"shim 只代理 ' + PREFIX + '/ 前缀"}')
      return
    }
    const rel = p.slice(PREFIX.length + 1)
    if (rel.startsWith('api/')) return proxyToBackend(req, res, url) // 真实 API
    const file = join(DIST, rel)
    if (rel && existsSync(file) && !statSync(file).isDirectory()) return serveDistFile(res, file) // 前端产物
    if (rel.startsWith('assets/')) return proxyToBackend(req, res, url) // 笔记图片等 data/assets 资源
    return serveDistFile(res, join(DIST, 'index.html')) // SPA 回退
  } catch (err) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`shim 内部错误：${err instanceof Error ? err.message : String(err)}`)
    } catch {
      /* 忽略 */
    }
  }
}

function stopShim() {
  try {
    shimServer?.close()
  } catch {
    /* 忽略 */
  }
  shimServer = null
}

/* ================= CDP 无头浏览器 ================= */

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
  const deadline = Date.now() + 30000
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

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = []
    this.pageErrors = []
    this.consoleErrors = []
    this.logErrors = []
    this.network = [] // {method,url,postData,status,responseBody}
    this.dialogs = 0
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((ok, no) => {
      ws.addEventListener('open', () => ok(), { once: true })
      ws.addEventListener('error', () => no(new Error('CDP 连接失败')), { once: true })
    })
    const cdp = new Cdp(ws)
    ws.addEventListener('message', (e) => cdp.#onMessage(JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))))
    ws.addEventListener('close', () => {
      for (const [, p] of cdp.pending) p.reject?.(new Error('CDP 连接关闭'))
      cdp.pending.clear()
    })
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')
    await cdp.send('Network.enable')
    return cdp
  }

  #onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    for (const h of this.handlers) h(msg)
    switch (msg.method) {
      case 'Runtime.exceptionThrown': {
        const d = msg.params?.exceptionDetails
        this.pageErrors.push(d?.exception?.description ?? d?.text ?? '未知异常')
        break
      }
      case 'Runtime.consoleAPICalled':
        if (msg.params?.type === 'error') {
          this.consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
        }
        break
      case 'Log.entryAdded': {
        const e = msg.params?.entry ?? {}
        if (e.level === 'error') {
          const text = e.text ?? ''
          const url = e.url ?? ''
          if (/favicon/.test(url) || /favicon/.test(text)) break
          this.logErrors.push(`${text}${url ? ` (${url})` : ''}`)
        }
        break
      }
      case 'Page.javascriptDialogOpening':
        this.dialogs += 1
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
        break
      case 'Network.requestWillBeSent': {
        const { requestId, request } = msg.params
        if (request?.url?.includes('/api/')) {
          this.network.push({
            requestId,
            method: request.method,
            url: request.url,
            postData: request.postData ?? '',
          })
        }
        break
      }
      case 'Network.responseReceived': {
        const rec = this.network.find((n) => n.requestId === msg.params.requestId)
        if (rec) rec.status = msg.params.response?.status
        break
      }
      case 'Network.loadingFinished': {
        const rec = this.network.find((n) => n.requestId === msg.params.requestId)
        if (rec && rec.status >= 200) {
          this.send('Network.getResponseBody', { requestId: msg.params.requestId })
            .then((r) => {
              rec.responseBody = r?.body ?? ''
            })
            .catch(() => {})
        }
        break
      }
      default:
        break
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(`Runtime.evaluate 异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result?.value
  }

  async waitFor(expr, ms, desc) {
    const deadline = Date.now() + ms
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await this.evalJs(expr)
        if (last) return last
      } catch (err) {
        last = String(err)
      }
      await sleep(150)
    }
    throw new Error(`等待超时（${ms}ms）：${desc}；最后结果=${JSON.stringify(last)?.slice(0, 200)}`)
  }

  async clickElement(findExpr, desc) {
    const rect = await this.evalJs(
      `(() => { const el = ${findExpr}; if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { zero: true, x: r.x, y: r.y };
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (el.textContent || '').trim().slice(0, 40) }; })()`,
    )
    if (!rect) throw new Error(`未找到元素：${desc}（${findExpr}）`)
    if (rect.zero) throw new Error(`元素尺寸为 0，无法点击：${desc}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', clickCount: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(80)
    return rect
  }

  async pressKey(key, opts = {}) {
    const base = {
      key,
      code: opts.code ?? key,
      windowsVirtualKeyCode: opts.vk ?? 0,
      nativeVirtualKeyCode: opts.vk ?? 0,
      modifiers: opts.modifiers ?? 0,
      text: opts.text ?? '',
    }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    if (opts.text) await this.send('Input.dispatchKeyEvent', { type: 'char', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async insertText(text) {
    await this.send('Input.insertText', { text })
  }

  async screenshot(name) {
    try {
      mkdirSync(SHOTS, { recursive: true })
      const r = await this.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
    } catch {
      /* 截图失败不影响测试 */
    }
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

/* ================= 页面内查询表达式 ================= */

const byText = (sel, text) =>
  `(function(){var els=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(sel)}));for(var i=0;i<els.length;i++){if(els[i].textContent.trim()===${JSON.stringify(text)})return els[i];}return null;})()`

const treeDocRow = (title) => `(function(){var l=${byText('.tree-doc .tree-label', title)};return l?l.closest('.tree-doc'):null;})()`

const TOAST_TIMEOUT = 12000

/* ================= 磁盘 .sy 工具 ================= */

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 定位根对象里第一处 depth===1 的 "Children" 数组的 '[' 位置 */
function findChildrenArray(text) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      if (depth === 1 && text.startsWith('"Children"', i)) {
        let k = text.indexOf(':', i + 10)
        if (k > 0) {
          k += 1
          while (k < text.length && /\s/.test(text[k])) k++
          if (text[k] === '[') return k
        }
      }
      inStr = true
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return -1
}

/** 取数组（start 指向 '['）中每个顶层元素的原文字符串 */
function arrayRawSpans(text, start) {
  const spans = []
  let depth = 0
  let inStr = false
  let esc = false
  let objStart = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      if (depth === 2 && ch === '{') objStart = i
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) break
      if (depth === 1 && ch === '}') spans.push(text.slice(objStart, i + 1))
    }
  }
  return spans
}

function readSy(box, id) {
  const path = join(USER_WS, 'data', box, `${id}.sy`)
  const raw = readFileSync(path, 'utf8')
  const json = JSON.parse(raw)
  const start = findChildrenArray(raw)
  return {
    path,
    raw,
    json,
    ids: (json.Children ?? []).map((c) => c.ID),
    types: (json.Children ?? []).map((c) => c.Type),
    spans: start >= 0 ? arrayRawSpans(raw, start) : [],
    updated: json.Properties?.updated,
    sha: sha256(Buffer.from(raw, 'utf8')),
  }
}

// 手写 zip 解析（EOCD → 中央目录 → 本地头 + inflateRaw），不依赖系统 unzip，
// 好处：能按 UTF-8 标志位正确还原中文条目名（Info-ZIP 在 Windows 控制台会显示乱码）。
function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录损坏 @${p}`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, utf8Flag: (flags & 0x800) !== 0, method, compSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  for (const e of entries) {
    const lp = e.localOffset
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`本地文件头损坏：${e.name}`)
    const lNameLen = buf.readUInt16LE(lp + 26)
    const lExtraLen = buf.readUInt16LE(lp + 28)
    const start = lp + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + e.compSize)
    e.data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
  }
  return entries
}

/* ================= 报告 ================= */

function buildReport(ctx) {
  const lines = []
  const pass = checks.filter((c) => c.ok).length
  const fail = checks.filter((c) => !c.ok && !c.skipped).length
  const skipped = checks.filter((c) => c.skipped).length

  lines.push('# zt-note 前后端端到端联调报告（真实后端 + 无头浏览器）')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 脚本：\`ui/scripts/e2e-live.mjs\`（运行产物在 \`.test/\`）`)
  lines.push(`- 页面地址：真实二进制 \`${APP_URL}\`（go:embed 产物，前缀模拟飞牛网关）${ctx.assetBug ? `（严格模式白屏，UI 断言实际跑在 \`${ctx.pageUrl}\`：仅静态文件代答、api/* 仍走真实后端）` : ''}`)
  lines.push(`- 数据根：\`${WS}\`（每次运行重建；用户工作区 \`users/${USER}/workspace\`；导入源：\`${SIYUAN_DATA}\`）`)
  lines.push(`- 浏览器：\`${ctx.browser || '(未找到)'}\`；Node ${process.version}`)
  lines.push(`- 结果：**${pass} 通过 / ${fail} 失败 / ${skipped} 跳过**`)
  lines.push('')

  lines.push('## 1. 结论')
  lines.push('')
  const shimChecks = checks.filter((c) => c.mode === 'shim')
  const shimFail = shimChecks.filter((c) => !c.ok && !c.skipped)
  if (ctx.fatal) {
    lines.push(`**联调未跑通**：在「${ctx.fatal}」阶段中止，前端与后端未能完成闭环。`)
  } else if (ctx.assetBug) {
    lines.push('**联调结论：不通 —— 阻塞在第 3 步「页面装配」。**')
    lines.push('')
    lines.push('真实 Go 二进制无法向浏览器提供前端产物自身的 `./assets/index-*.js|css`：该路径被后端数据资源路由 `/assets/` 抢先命中，')
    lines.push('返回 `404 {"error":"资源不存在","ok":false}`（JSON），页面只渲染 `.boot` 占位（白屏），`type=module` 脚本还因 MIME 校验直接报错。')
    lines.push('与网关切前缀无关，无前缀直连（文档 URL 为 `/`）同样复现——即**前端产物从未真正在真实后端下跑起来过**。')
    lines.push('')
    lines.push(
      `为避免这个阻塞项掩盖后面的契约验证，脚本随后用**测试代理**（仅代答 dist 静态文件，\`api/*\` 与笔记图片仍转发真实后端）把页面拉起来，` +
        `继续跑完了编辑保存 / 磁盘保真 / 无改动保存 / 搜索 / 导出：**${
          shimChecks.length - shimFail.length
        }/${shimChecks.length} 通过**` +
        (shimFail.length ? `，失败：${shimFail.map((c) => c.name).join('；')}` : '（全部通过）'),
    )
    lines.push('')
    lines.push('—— 也就是说：**产品态联调不通（前端静态资源路由冲突）；API 层契约本身是吻合的**（详见下面 shim 模式断言与第 3 节证据）。')
  } else if (fail === 0 && bugs.length === 0) {
    lines.push('前后端联调**全部通过**：UI 装配、文档树、正文渲染、编辑保存、磁盘保真（changed:false 通道）、')
    lines.push('无改动保存零字节写入、搜索跳转、思源导出 zip 与磁盘一致。')
  } else if (fail === 0) {
    lines.push('核心链路（含编辑保存 + 磁盘保真）**全部通过**，另有下面的契约不一致/观察项需要主线程确认。')
  } else {
    lines.push(`联调**未完全通过**：${fail} 项断言失败，见第 2 节；卡点与证据见第 3 节。`)
  }
  lines.push('')

  lines.push('## 2. 逐项断言')
  lines.push('')
  lines.push('| # | 模式 | 分组 | 断言 | 结果 | 说明 |')
  lines.push('|---|---|---|---|---|---|')
  checks.forEach((c, i) => {
    const state = c.ok ? '通过' : c.skipped ? '跳过' : '**失败**'
    const detail = c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)
    lines.push(`| ${i + 1} | ${c.mode ?? 'strict'} | ${c.group} | ${c.name} | ${state} | ${detail} |`)
  })
  lines.push('')

  lines.push('## 3. 关键证据')
  lines.push('')
  lines.push('### 3.1 导入与 stats')
  lines.push('')
  lines.push('```')
  lines.push(`POST ${API}/import/path  body: {"path":"${SIYUAN_DATA}"}`)
  lines.push(`响应（截断）：${clip(ctx.importResp, 400)}`)
  lines.push('')
  lines.push(`GET ${API}/health → stats（实测）：${JSON.stringify(ctx.healthStats)}`)
  lines.push(`期望：${JSON.stringify(EXPECT_STATS)}`)
  lines.push('```')
  lines.push('')

  lines.push('### 3.2 阻塞项证据：前端产物 /assets/* 被后端数据资源路由吃掉')
  lines.push('')
  lines.push('```')
  if (ctx.assetBug) {
    lines.push(`GET ${BASE}${PREFIX}/          → HTTP ${ctx.assetBug.indexStatus}，index.html 引用 ${ctx.assetBug.jsPath}`)
    lines.push(`GET ${ctx.assetBug.jsUrl}`)
    lines.push(`  → HTTP ${ctx.assetBug.jsStatus}  content-type: ${ctx.assetBug.jsType}`)
    lines.push(`  → body: ${ctx.assetBug.jsBody}`)
    if (ctx.assetBug.cssUrl) {
      lines.push(`GET ${ctx.assetBug.cssUrl}`)
      lines.push(`  → HTTP ${ctx.assetBug.cssStatus}  content-type: ${ctx.assetBug.cssType}`)
    }
    lines.push(`internal/webui/dist/assets/ 实际存在：${JSON.stringify(ctx.assetBug.distFiles)}`)
    lines.push('结论：请求被 internal/server/server.go:60 的 /assets/ 路由接走，handleAsset（:362-378）只查 data/assets，')
    lines.push('返回 404 JSON；handleStatic（:389-395）永远轮不到 assets/*。无前缀直连模式同样命中该路由。')
  } else {
    lines.push('(严格模式未发现该问题)')
  }
  lines.push('```')
  lines.push('')

  lines.push('### 3.3 页面装配与正文渲染')
  lines.push('')
  lines.push('```')
  lines.push(`UI 阶段使用的页面地址 = ${ctx.pageUrl ?? APP_URL}${ctx.assetBug ? '（测试代理：静态资源代答，api/* 走真实后端）' : ''}`)
  lines.push(`document.title = ${JSON.stringify(ctx.title)}`)
  lines.push(`笔记本 = ${JSON.stringify(ctx.notebooks)}`)
  lines.push(`文档树条目数 = ${ctx.docCount}，含《${DOC_TITLE}》：${ctx.hasTargetDoc}`)
  lines.push(`《${DOC_TITLE}》归属：box=${ctx.docBox}（${ctx.docBoxName}）`)
  lines.push(`阅读区包含 ${READ_TEXT.map((t) => JSON.stringify(t)).join('、')}：${ctx.readTextOk}`)
  lines.push('```')
  lines.push('')

  lines.push('### 3.4 编辑保存：前端实际发出的 api/doc/save')
  lines.push('')
  lines.push('```')
  if (ctx.saveReq) {
    lines.push(`POST ${ctx.saveReq.url}`)
    lines.push(`请求体（截断 1200 字符）：${clip(ctx.saveReq.postData, 1200)}`)
    lines.push(`响应（截断 600 字符）：${clip(ctx.saveReq.responseBody, 600)}`)
  } else {
    lines.push('(未捕获到 api/doc/save 请求)')
  }
  lines.push('```')
  lines.push('')

  lines.push('### 3.5 磁盘 .sy 校验（编辑一次）')
  lines.push('')
  lines.push('```')
  if (ctx.disk) {
    lines.push(`文件：${ctx.disk.path}`)
    lines.push(`块 ID（前→后）：${ctx.disk.idsBefore.length} → ${ctx.disk.idsAfter.length}，序列一致：${ctx.disk.idsSame}`)
    lines.push(`顶层块数：${ctx.disk.countBefore} → ${ctx.disk.countAfter}`)
    lines.push(`Properties.updated：${ctx.disk.updatedBefore} → ${ctx.disk.updatedAfter}（已刷新：${ctx.disk.updatedRefreshed}）`)
    lines.push(`逐块原文字节对比：变化块下标 = ${JSON.stringify(ctx.disk.changedIndexes)}，未变块原文字节全等 = ${ctx.disk.untouchedByteEqual}`)
    lines.push(`新文本已落盘：${ctx.disk.newTextOnDisk}；落盘块结构：${ctx.disk.changedBlockShape}`)
    lines.push(`sha256：${ctx.disk.shaBefore} → ${ctx.disk.shaAfter}`)
  } else {
    lines.push('(未执行磁盘校验)')
  }
  lines.push('```')
  lines.push('')

  lines.push('### 3.6 无改动直接保存（字节保真）')
  lines.push('')
  lines.push('```')
  if (ctx.noop) {
    lines.push(`保存前 sha256 = ${ctx.noop.shaBefore}`)
    lines.push(`保存后 sha256 = ${ctx.noop.shaAfter}`)
    lines.push(`字节完全一致：${ctx.noop.byteEqual}`)
    lines.push(`该次请求 changed 标记：${JSON.stringify(ctx.noop.changedFlags)}（全 false：${ctx.noop.allFalse}）`)
    lines.push(`保存前磁盘 mtime = ${ctx.noop.mtimeBefore}；保存后 = ${ctx.noop.mtimeAfter}`)
  } else {
    lines.push('(未执行无改动保存)')
  }
  lines.push('```')
  lines.push('')

  lines.push('### 3.7 搜索与导出')
  lines.push('')
  lines.push('```')
  if (ctx.search) {
    lines.push(`搜索「贷款」：后端 api/search 命中 ${ctx.search.apiHits?.length ?? '-'} 条；页面标题 = ${JSON.stringify(ctx.search.pageTitle)}`)
    if (ctx.search.apiHits?.length) lines.push(`api/search 原始首条：${JSON.stringify(ctx.search.apiHits[0])}`)
    lines.push(`首条命中：${clip(ctx.search.firstHit, 300)}；卡片 tooltip = ${JSON.stringify(ctx.search.tooltip)}`)
    lines.push(`点击后打开文档 = ${JSON.stringify(ctx.search.openedTitle)}（hash=${ctx.search.hash}）`)
    if (ctx.search.bodyHit) {
      lines.push(`正文命中（步骤 [6] 写入的文本）：query=${JSON.stringify(ctx.search.bodyHit.query)} 条数=${ctx.search.bodyHit.hits} blockId=${JSON.stringify(ctx.search.bodyHit.blockId)} tooltip=${JSON.stringify(ctx.search.bodyHit.tooltip)}`)
      lines.push(`  api/search snippet=${JSON.stringify(ctx.search.bodyHit.snippet)}；卡片=${JSON.stringify(ctx.search.bodyHit.first)}`)
    }
    if (ctx.search.bodyJump) {
      lines.push(`块级定位：hash=${ctx.search.bodyJump.hash} .block-flash=${ctx.search.bodyJump.flash} data-node-id=${JSON.stringify(ctx.search.bodyJump.flashedId)}`)
    }
  }
  if (ctx.exportSiYuan) {
    lines.push(`思源导出 zip：${ctx.exportSiYuan.entries} 个条目，其中 .sy ${ctx.exportSiYuan.syCount} 个`)
    lines.push(`逐条与磁盘比对：${ctx.exportSiYuan.matched}/${ctx.exportSiYuan.compared} 相等，全部一致：${ctx.exportSiYuan.allEqual}`)
    if (ctx.exportSiYuan.mismatch.length) lines.push(`不一致条目：${JSON.stringify(ctx.exportSiYuan.mismatch)}`)
  }
  if (ctx.exportMd) {
    lines.push(
      `Markdown 导出 zip：${ctx.exportMd.entries} 个条目 = ${ctx.exportMd.docs} 篇文档 .md + ${ctx.exportMd.readme} 个笔记本 README.md + 资源；` +
        `其中 assets 与磁盘比对 ${ctx.exportMd.assetMatched}/${ctx.exportMd.assetCompared} 一致`,
    )
    lines.push(`文档名（前 14）：${ctx.exportMd.docTitles.join(' / ')}`)
  }
  if (ctx.exportSiYuan) {
    lines.push(`条目名 UTF-8 标志位：${ctx.exportSiYuan.utf8Ok ? '正确' : '缺失/乱码'}`)
  }
  lines.push('```')
  lines.push('')

  lines.push('### 3.8 前端异常')
  lines.push('')
  lines.push('```')
  lines.push(`pageerror（未捕获异常）：${ctx.jsErrors?.page?.length ?? 0} 条${ctx.jsErrors?.page?.length ? ' — ' + ctx.jsErrors.page.slice(0, 3).join(' | ') : ''}`)
  lines.push(`console.error：${ctx.jsErrors?.console?.length ?? 0} 条${ctx.jsErrors?.console?.length ? ' — ' + ctx.jsErrors.console.slice(0, 3).join(' | ') : ''}`)
  lines.push(`Log.entryAdded(level=error)：${ctx.jsErrors?.log?.length ?? 0} 条${ctx.jsErrors?.log?.length ? ' — ' + ctx.jsErrors.log.slice(0, 3).join(' | ') : ''}`)
  lines.push(`会话内网络请求（/api/）：${(ctx.apiTraffic ?? []).length} 个`)
  lines.push('```')
  lines.push('')

  lines.push('## 4. 发现的问题 / 与任务假设不一致')
  lines.push('')
  if (!bugs.length) {
    lines.push('无（未发现前端与后端契约不一致；下述为观察项）')
  }
  bugs.forEach((b, i) => {
    lines.push(`### 4.${i + 1} ${b.title}`)
    lines.push('')
    lines.push(`- **现象**：${b.symptom}`)
    lines.push(`- **复现**：${b.repro}`)
    lines.push(`- **期望**：${b.expected}`)
    lines.push(`- **实际**：${b.actual}`)
    lines.push(`- **涉及文件**：${b.files}`)
    if (b.hint) lines.push(`- **可能方向（仅供决策，脚本未改任何产品代码）**：${b.hint}`)
    lines.push('')
  })
  if (warnings.length) {
    lines.push('### 其它观察')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push(
    '> 环境备注：Windows 控制台下 `unzip -Z1` 会把中文条目名显示为乱码，属 Info-ZIP 的显示问题；脚本改用 Node 自解析 zip（EOCD→中央目录→inflateRaw）并校验 UTF-8 标志位，导出 zip 的条目名本身是正确的（见 3.7）。',
  )
  lines.push('')

  lines.push('## 5. 环境与运行信息')
  lines.push('')
  lines.push('```')
  lines.push(`cwd = ${ROOT}`)
  lines.push(`后端命令 = ${EXE} -data .test/uiws -addr ${HOST}:${PORT} -prefix ${PREFIX}`)
  lines.push(`health.prefix = ${JSON.stringify(ctx.healthPrefix)}`)
  lines.push(`health.frontend = ${JSON.stringify(ctx.healthFrontend)}（go:embed 产物可用）`)
  lines.push(`health.version = ${JSON.stringify(ctx.healthVersion)}`)
  const fp = (p) => {
    try {
      return `${sha256(readFileSync(p)).slice(0, 16)}… mtime=${statSync(p).mtime.toISOString()}`
    } catch {
      return '(不可读)'
    }
  }
  lines.push(`后端 exe 指纹 = ${fp(EXE)}`)
  lines.push(`内嵌前端产物 dist/index.html 指纹 = ${fp(join(DIST, 'index.html'))}`)
  lines.push('后端日志尾部：')
  lines.push(tail(SERVER_LOG, 25))
  lines.push('```')
  lines.push('')
  lines.push('> 说明：本报告由 `ui/scripts/e2e-live.mjs` 自动生成，未修改任何前端/后端产品代码。')
  lines.push('')
  return lines.join('\n')
}

const clip = (s, n) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null)
  return t.length > n ? `${t.slice(0, n)}…[截断，共 ${t.length} 字符]` : t
}

/* ================= 主流程 ================= */

const ctx = { fatal: '', browser: '' }

async function main() {
  log(`zt-note 端到端联调（真实后端 + 无头 Chrome）`)
  log(`项目根：${ROOT}`)

  /* --- 1. 构建后端 --- */
  log('\n[1] 构建后端')
  buildBackend()

  /* --- 2. 启动服务 + 导入 --- */
  log('\n[2] 启动后端并导入真实数据')
  const health = await startServer()
  ctx.healthPrefix = health.prefix
  ctx.healthFrontend = health.frontend
  ctx.healthVersion = health.version
  check('2-服务', `后端就绪 ${API}/health（前缀 ${PREFIX}）`, Boolean(health.ok), `version=${health.version} dataDir=${health.dataDir}`)
  check('2-服务', `-prefix 未被改写（health.prefix === "${PREFIX}"）`, health.prefix === PREFIX, `实际 prefix=${JSON.stringify(health.prefix)}`)
  check('2-服务', 'go:embed 前端产物可用（health.frontend=true）', health.frontend === true, `frontend=${JSON.stringify(health.frontend)}`)

  /* --- 2b. PIN 门：未解锁时一律看不到数据 --- */
  log('\n[2b] PIN 门：未设置 → 设置 → 锁定 → 解锁')
  try {
    const s0 = await getJson(`${API}/session`)
    check('2b-PIN', 'GET api/session 未设 PIN 时 needsSetup=true 且 locked=true', s0.needsSetup === true && s0.locked === true, JSON.stringify({ needsSetup: s0.needsSetup, locked: s0.locked, uid: s0.user?.uid, hasLibrary: s0.hasLibrary }))
    check('2b-PIN', 'session.user 带上了网关身份（本地开发是 local）', s0.user?.uid === USER, `uid=${JSON.stringify(s0.user?.uid)} name=${JSON.stringify(s0.user?.name)}`)

    const lockedTree = await httpJson(`${API}/tree`)
    check('2b-PIN', '未解锁时 GET api/tree → 401（不泄露标题）', lockedTree.status === 401, `status=${lockedTree.status} body=${clip(lockedTree.text, 120)}`)
    const lockedAsset = await httpJson(`${API}/assets/nope.png`)
    check('2b-PIN', '未解锁时 GET assets/* → 401（不泄露图片）', lockedAsset.status === 401, `status=${lockedAsset.status}`)

    const badPin = await postJson(`${API}/pin/setup`, { pin: '123' })
    check('2b-PIN', 'api/pin/setup 校验位数（123 → 400）', badPin.status === 400, `status=${badPin.status} body=${clip(badPin.text, 120)}`)

    const setup = await postJson(`${API}/pin/setup`, { pin: TEST_PIN })
    const setupOk = setup.status === 200 && setup.data?.ok === true && setup.data?.onboarded === true && setup.data?.weak === false
    check('2b-PIN', `api/pin/setup 设置 PIN（${TEST_PIN}）并发会话 Cookie`, setupOk, clip(setup.data ?? setup.text, 200))
    if (!setupOk) {
      bug('设置 PIN 失败', 'POST api/pin/setup 未返回预期的 ok/onboarded/weak', `curl -s -X POST ${API}/pin/setup -H 'Content-Type: application/json' -d '{"pin":"${TEST_PIN}"}'`, 'HTTP 200 + {ok:true,onboarded:true,weak:false}', clip(setup.data ?? setup.text, 300), 'internal/server/pin.go handlePinSetup')
      ctx.fatal = 'PIN 设置'
      return
    }
    check('2b-PIN', 'Cookie 已拿到（后续请求自动带上）', COOKIE.startsWith('ztnote_session='), COOKIE ? '已捕获 ztnote_session' : '(空)')

    // 首次进入白送的库与欢迎文档
    const welcomeTree = await getJson(`${API}/tree`)
    const welcomeBoxes = (welcomeTree.notebooks ?? []).map((nb) => nb.name)
    check('2b-PIN', `首次进入自动建《${WELCOME_BOX}》`, welcomeBoxes.length === 1 && welcomeBoxes[0] === WELCOME_BOX, `notebooks=${JSON.stringify(welcomeBoxes)}`)
    const welcomeDoc = (welcomeTree.notebooks?.[0]?.docs ?? [])[0]
    check('2b-PIN', '自动建了一篇欢迎文档', Boolean(welcomeDoc), welcomeDoc ? `id=${welcomeDoc.id} title=${JSON.stringify(welcomeDoc.title)}` : '没找到')
    if (welcomeDoc) {
      const wd = await getJson(`${API}/doc?box=${welcomeTree.notebooks[0].id}&id=${welcomeDoc.id}`)
      const hints = ['PIN', '导入', '导出', '数据']
      const hit = hints.filter((t) => (wd.html ?? '').includes(t))
      check('2b-PIN', `欢迎文档正文可读（含 ${hints.join('/')} 中的 ${hit.length} 个）`, hit.length >= 3, `blocks=${(wd.blocks ?? []).length} 命中=${JSON.stringify(hit)}`)
    }
    const welcomeStats = (await getJson(`${API}/session`)).stats ?? {}
    ctx.welcomeStats = welcomeStats

    // 换个身份（另一个 NAS 账号）不应该能看到别人的库
    const otherId = await httpJson(`${API}/tree`, { headers: { 'X-Trim-Userid': '1001', 'X-Trim-Name': 'other', 'X-Trim-Isadmin': 'false' } })
    check('2b-PIN', '另一个 NAS 账号（无 PIN 会话）→ 401，看不到 1000 的库', otherId.status === 401, `status=${otherId.status} body=${clip(otherId.text, 120)}`)

    // 锁上再解开：验证密码校验与限流提示
    const lock = await postJson(`${API}/pin/lock`, {})
    check('2b-PIN', 'api/pin/lock 锁定成功', lock.status === 200 && lock.data?.locked === true, clip(lock.data ?? lock.text, 120))
    const afterLock = await httpJson(`${API}/tree`)
    check('2b-PIN', '锁定后 GET api/tree → 401', afterLock.status === 401, `status=${afterLock.status}`)

    const wrong = await postJson(`${API}/pin/unlock`, { pin: '000001' })
    check('2b-PIN', 'api/pin/unlock 错码 → 401 且提示剩余次数', wrong.status === 401 && /还能试/.test(String(wrong.data?.error ?? '')), `status=${wrong.status} error=${JSON.stringify(wrong.data?.error)}`)

    const unlock = await postJson(`${API}/pin/unlock`, { pin: TEST_PIN })
    check('2b-PIN', 'api/pin/unlock 正确 PIN → 200 并重新发 Cookie', unlock.status === 200 && unlock.data?.ok === true, clip(unlock.data ?? unlock.text, 160))
    check('2b-PIN', '解锁后 GET api/tree 恢复可用', (await getJson(`${API}/tree`)).notebooks?.length === 1, '树里只有欢迎笔记本')

    const weakChange = await postJson(`${API}/pin/change`, { old: TEST_PIN, new: '123456' })
    check('2b-PIN', 'api/pin/change 弱口令会被标记 weak=true', weakChange.status === 200 && weakChange.data?.weak === true, clip(weakChange.data ?? weakChange.text, 160))
    const backChange = await postJson(`${API}/pin/change`, { old: '123456', new: TEST_PIN })
    check('2b-PIN', `api/pin/change 改回 ${TEST_PIN}`, backChange.status === 200 && backChange.data?.weak === false, clip(backChange.data ?? backChange.text, 160))
    const badOld = await postJson(`${API}/pin/change`, { old: '999999', new: TEST_PIN })
    check('2b-PIN', 'api/pin/change 原 PIN 错误 → 401', badOld.status === 401, `status=${badOld.status}`)
  } catch (err) {
    check('2b-PIN', 'PIN 链路执行', false, err instanceof Error ? err.message : String(err))
    ctx.fatal = 'PIN 链路'
    return
  }

  const imp = await postJson(`${API}/import/path`, { path: SIYUAN_DATA })
  ctx.importResp = imp.data
  const impOk = imp.status === 200 && imp.data?.ok === true
  check('2-导入', 'POST api/import/path 导入思源数据', impOk, clip(imp.data ?? imp.text, 240))
  if (!impOk) {
    bug(
      '导入真实数据失败',
      'POST api/import/path 没有返回 ok:true',
      `curl -s -X POST ${API}/import/path -H 'Content-Type: application/json' -d '{"path":"${SIYUAN_DATA}"}'`,
      'HTTP 200 + {"ok":true,"notebooks":[2],...}',
      clip(imp.data ?? imp.text, 400),
      'internal/server/server.go handleImportPath',
    )
    ctx.fatal = '导入数据'
    return
  }

  const health2 = await getJson(`${API}/health`)
  ctx.healthStats = health2.stats
  const stats = health2.stats ?? {}
  const welcome = ctx.welcomeStats ?? {}
  for (const [k, v] of Object.entries(EXPECT_STATS)) {
    const want = v + (welcome[k] ?? 0)
    check(
      '2-stats',
      `stats.${k} === ${want}（导入 ${v} + 欢迎库 ${welcome[k] ?? 0}）`,
      stats[k] === want,
      `实际 ${JSON.stringify(stats[k])}（全量 stats=${JSON.stringify(stats)}）`,
    )
  }

  const tree = await getJson(`${API}/tree`)
  const boxNames = (tree.notebooks ?? []).map((nb) => nb.name)
  const target = findDoc(tree.notebooks ?? [], DOC_TITLE)
  check('2-数据', `文档树含 ${EXPECT_BOXES} 个笔记本（含《${WELCOME_BOX}》）：${JSON.stringify(boxNames)}`, (tree.notebooks ?? []).length === EXPECT_BOXES, `${(tree.notebooks ?? []).length} 个：${boxNames.join('、')}`)
  check('2-数据', `定位到《${DOC_TITLE}》`, Boolean(target), target ? `box=${target.box}（${target.boxName}）doc=${target.id}` : '未找到')

  if (!target) {
    bug(
      `文档树中找不到《${DOC_TITLE}》`,
      '导入响应成功，但 api/tree 里没有目标文档，无法继续点击链路',
      `curl -s ${API}/tree`,
      `包含标题为 ${DOC_TITLE} 的文档`,
      `笔记本 ${JSON.stringify(boxNames)}`,
      'internal/store/store.go Notebooks',
    )
    ctx.fatal = '定位目标文档'
    return
  }
  if (target.boxName !== '示例笔记本') {
    bug(
      `《${DOC_TITLE}》实际归属 ${target.boxName}，与任务描述的「示例笔记本 下的《示例文档》」不一致`,
      '任务书写的是点击「示例笔记本」下的《示例文档》，实际该文档在另一个笔记本下',
      `curl -s "${API}/doc?box=${target.box}&id=${target.id}"`,
      '示例文档 位于 示例笔记本（box 20250708095329-8rxeagf）',
      `实际 box=${target.box}（${target.boxName}），已按实际路径点击`,
      '数据本身（示例工作区/data/<box>/<doc>.sy），非代码 bug',
    )
  }
  ctx.docBox = target.box
  ctx.docBoxName = target.boxName
  ctx.targetDocId = target.id

  const docResp = await getJson(`${API}/doc?box=${target.box}&id=${target.id}`)
  const readOk = READ_TEXT.every((t) => (docResp.html ?? '').includes(t))
  check('2-数据', `GET api/doc 返回正文含 ${READ_TEXT.map((t) => `「${t}」`).join('、')}`, readOk, `blocks=${(docResp.blocks ?? []).length} updated=${docResp.updated}`)
  if (!readOk) {
    bug(
      'api/doc 返回的 html 缺少预期关键文本',
      `《${DOC_TITLE}》正文里找不到 ${READ_TEXT.join(' / ')}`,
      `curl -s "${API}/doc?box=${target.box}&id=${target.id}"`,
      `html 包含 ${READ_TEXT.join('、')}`,
      `html（截断）=${clip(docResp.html, 200)}`,
      'internal/siyuan/render.go、internal/store/store.go Detail',
    )
  }

  const syBefore = readSy(target.box, target.id)

  /* --- 3. 无头 Chrome --- */
  log('\n[3] 启动无头 Chrome 并打开真实页面')
  const browser = findBrowser()
  ctx.browser = browser
  if (!browser) {
    check('3-浏览器', '找到 Chrome/Edge 可执行文件', false, '可用 CHROME_PATH 指定')
    ctx.fatal = '寻找浏览器'
    return
  }
  check('3-浏览器', '找到 Chrome/Edge 可执行文件', true, browser)

  const profile = mkdtempSync(join(tmpdir(), 'zt-note-e2e-'))
  const debugPort = 9100 + Math.floor(Math.random() * 800)
  const chrome = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  ctx.chrome = chrome
  ctx.profile = profile

  const targetInfo = await waitForTarget(debugPort)
  const cdp = await Cdp.connect(targetInfo.webSocketDebuggerUrl)
  ctx.cdp = cdp

  // 页面加载完成事件
  let loaded = false
  cdp.handlers.push((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true
  })

  const nav = async (url, label) => {
    loaded = false
    await cdp.send('Page.navigate', { url })
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !loaded) await sleep(100)
    await sleep(400)
    check('3-页面', `${label} 触发 Page.loadEventFired`, loaded, url)
  }

  /* 3a. 严格模式：只用真实二进制 */
  await nav(APP_URL, '真实后端直出页面')

  // 未解锁时应该停在 PIN 屏，且拿不到任何笔记数据
  const gateState = await cdp
    .waitFor(
      `(() => { const g = document.querySelector('.gate'); if (!g) return null; return { shell: !!document.querySelector('.shell'), text: (g.textContent || '').slice(0, 160) } })()`,
      9000,
      '.gate（PIN 屏）出现',
    )
    .catch(() => null)
  check('3-锁屏', '未解锁时显示 PIN 屏且不渲染主界面', Boolean(gateState) && gateState.shell === false, gateState ? clip(gateState.text, 160) : '没找到 .gate')
  const lockedFetch = await cdp.evalJs(`fetch('api/tree').then((r) => r.status).catch(() => -1)`)
  check('3-锁屏', '页面内 fetch api/tree → 401（未解锁不给目录）', lockedFetch === 401, `status=${lockedFetch}`)

  // 在 PIN 屏上输入 PIN 解锁
  await cdp.evalJs(`(() => { const el = document.querySelector('.pin-input'); if (el) el.focus(); return !!el })()`)
  await cdp.insertText(TEST_PIN)
  let strictShell = false
  try {
    strictShell = Boolean(await cdp.waitFor(`!!document.querySelector('.shell')`, 9000, '解锁后出现主界面'))
  } catch {
    strictShell = false
  }
  if (!strictShell) {
    warn('CDP 输入 PIN 未生效，改用直接赋值 + input 事件兜底')
    await cdp.evalJs(
      `(() => { const el = document.querySelector('.pin-input'); if (!el) return false; el.value = ${JSON.stringify(TEST_PIN)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    )
    try {
      strictShell = Boolean(await cdp.waitFor(`!!document.querySelector('.shell')`, 9000, '解锁后出现主界面'))
    } catch {
      strictShell = false
    }
  }
  check('3-锁屏', `在 PIN 屏输入 ${TEST_PIN} 后进入主界面`, strictShell, strictShell ? '已解锁，.shell 已渲染' : '仍停在 PIN 屏')
  const gateGone = await cdp.evalJs(`!document.querySelector('.gate')`)
  check('3-锁屏', '解锁后 PIN 屏已移除', gateGone === true, String(gateGone))
  const bootState = await cdp.evalJs(`(() => ({
    boot: (document.querySelector('.boot') && document.querySelector('.boot').textContent || '').trim(),
    appChildren: (document.querySelector('#app') && document.querySelector('#app').children.length) || 0,
  }))()`)
  check(
    '3-页面',
    '真实二进制直出页面可装配（.shell 出现）',
    strictShell,
    strictShell
      ? '真实后端单靠自身即可提供前端资源'
      : `页面停在启动占位（#app > ${bootState?.appChildren} 个子节点，boot=${JSON.stringify(bootState?.boot)}）`,
  )

  if (!strictShell) {
    const indexHtmlRes = await fetch(`${BASE}${PREFIX}/`)
    const indexHtml = await indexHtmlRes.text()
    const jsPath = /src="([^"]+\.js)"/.exec(indexHtml)?.[1] ?? './assets/index-RAGgJGYt.js'
    const cssPath = /href="([^"]+\.css)"/.exec(indexHtml)?.[1] ?? ''
    const toAbs = (rel) => new URL(rel, `${BASE}${PREFIX}/`).toString()
    const jsUrl = toAbs(jsPath)
    const jsRes = await fetch(jsUrl)
    const jsBody = await jsRes.text()
    const cssUrl = cssPath ? toAbs(cssPath) : ''
    const cssRes = cssUrl ? await fetch(cssUrl) : null
    const distFiles = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : []
    const assetBug = {
      indexStatus: indexHtmlRes.status,
      jsPath,
      jsUrl,
      jsStatus: jsRes.status,
      jsType: jsRes.headers.get('content-type'),
      jsBody: jsBody.slice(0, 160),
      cssUrl,
      cssStatus: cssRes?.status ?? null,
      cssType: cssRes?.headers.get('content-type') ?? '',
      distFiles,
    }
    ctx.assetBug = assetBug
    check('3-页面', `前端产物 JS 可获取（${jsPath}）`, jsRes.ok, `HTTP ${jsRes.status} content-type=${assetBug.jsType} body=${clip(assetBug.jsBody, 80)}`)
    check('3-页面', `前端产物 CSS 可获取（${cssPath || '未找到'}）`, Boolean(cssRes?.ok), `HTTP ${assetBug.cssStatus} content-type=${assetBug.cssType}`)
    bug(
      '阻塞：后端 /assets/ 路由吃掉了前端产物自身的 assets/index-*.js|css，真实二进制页面白屏',
      '浏览器打开真实后端页面只渲染 .boot 占位，引用 ./assets/index-*.js|css 的请求全部 404（JSON 错误体），应用无法装配；无前缀直连模式同样中招（文档 URL 为 /，相对路径同样落到 /assets/）',
      [
        '.test/ztnote.exe -data .test/uiws -addr 127.0.0.1:8801 -prefix /app/zt-note',
        `curl -s ${BASE}${PREFIX}/   # index.html 引用 ${jsPath}`,
        `curl -sD - ${jsUrl}`,
        cssUrl ? `curl -sD - ${cssUrl}` : '(无 css)',
        'ls internal/webui/dist/assets/',
      ].join('\n'),
      '页面能加载 ./assets/index-*.js 与 ./assets/index-*.css（200 + JS/CSS MIME），app 装配出 .shell',
      `JS → HTTP ${assetBug.jsStatus} ${assetBug.jsType} ${clip(assetBug.jsBody, 60)}；CSS → HTTP ${assetBug.cssStatus} ${assetBug.cssType}；dist 内文件实际存在：${JSON.stringify(distFiles)}`,
      'internal/server/server.go:60（mux.HandleFunc("/assets/", s.handleAsset)）、internal/server/server.go:362-378（handleAsset 只查 data/assets）、internal/server/server.go:389-395（handleStatic 永远轮不到 assets/*）；ui/vite.config.ts:10（base:"./"）、:15（assetsDir:"assets"）、:23（dev 把 /assets 代理给后端，说明 /assets 本就是后端保留路径）；internal/webui/dist/index.html:8-9',
      '仅供主线程决策，本次未改任何代码：① ui/vite.config.ts:15 把 assetsDir 改成与后端保留路径不冲突的目录（如 static）后重建 dist；② 或 server.go:362 的 handleAsset 在 data/assets 里找不到文件时回退给 handleStatic（embed）——注意笔记正文里的图片引用是相对路径 assets/xxx.png（ui/src/editor.ts:196、:239），后端 /assets/ 路由本身不能删。',
    )
  }

  /* 3b. 严格模式被阻塞时，用测试代理继续验证“API 链路”（仅代答前端静态文件；api/* 与笔记图片仍转发真实后端） */
  let pageUrl = APP_URL
  if (!strictShell) {
    await startShim()
    MODE = 'shim'
    pageUrl = SHIM_URL
    log('  → 启用测试代理（仅代答 dist 静态文件；api/* 与 data/assets 仍旧转发真实后端），以继续验证保存/磁盘链路')
    await nav(SHIM_URL, '经测试代理打开页面')
    await cdp.waitFor(`!!document.querySelector('.shell')`, 15000, '.shell 布局出现（shim）')
    check('3-页面', '经测试代理后页面装配成功（前端产物本身可用）', true, SHIM_URL)
  }
  ctx.pageUrl = pageUrl
  await cdp.waitFor(
    `!!document.querySelector('.tree-notebook') || !!document.querySelector('.error-box') || !!document.querySelector('.empty-box')`,
    15000,
    '文档树加载完成',
  )

  const pageInfo = await cdp.evalJs(`(() => ({
    title: document.title,
    hasShell: !!document.querySelector('.shell'),
    hasTopbar: !!document.querySelector('.topbar'),
    hasSidebar: !!document.querySelector('.sidebar'),
    hasMain: !!document.querySelector('.main'),
    notebooks: Array.prototype.slice.call(document.querySelectorAll('.tree-notebook .tree-label')).map(function(e){return e.textContent.trim()}),
    docs: Array.prototype.slice.call(document.querySelectorAll('.tree-doc .tree-label')).map(function(e){return e.textContent.trim()}),
    version: (document.querySelector('.version') && document.querySelector('.version').textContent || '').trim(),
    treeError: (document.querySelector('.tree .error-msg') && document.querySelector('.tree .error-msg').textContent || '').trim(),
    homeText: (document.querySelector('.main') && document.querySelector('.main').innerText || '').slice(0, 120),
  }))()`)
  ctx.title = pageInfo.title
  ctx.notebooks = pageInfo.notebooks
  ctx.docCount = pageInfo.docs.length
  ctx.hasTargetDoc = pageInfo.docs.includes(DOC_TITLE)
  ctx.version = pageInfo.version

  check('3-页面', `document.title = ${JSON.stringify(pageInfo.title)}（含 zt-note）`, /zt-note/.test(pageInfo.title ?? ''), pageInfo.title)
  check('3-页面', '.shell / .topbar / .sidebar / .main 布局齐全', pageInfo.hasShell && pageInfo.hasTopbar && pageInfo.hasSidebar && pageInfo.hasMain, JSON.stringify({ shell: pageInfo.hasShell, topbar: pageInfo.hasTopbar, sidebar: pageInfo.hasSidebar, main: pageInfo.hasMain }))
  check('3-页面', '顶栏版本号来自真实后端 health（不是「连接中…」）', /^v/.test(pageInfo.version ?? ''), `version 区文案=${JSON.stringify(pageInfo.version)}`)
  check('3-树', `文档树渲染 ${EXPECT_BOXES} 个笔记本且含 笔记本A / 示例笔记本 / ${WELCOME_BOX}`, pageInfo.notebooks.length === EXPECT_BOXES && pageInfo.notebooks.includes('笔记本A') && pageInfo.notebooks.includes('示例笔记本') && pageInfo.notebooks.includes(WELCOME_BOX), JSON.stringify(pageInfo.notebooks))
  check('3-树', `笔记本展开后渲染 ${EXPECT_DOCS} 个文档条目且含《${DOC_TITLE}》（含首次进入的欢迎文档）`, pageInfo.docs.length === EXPECT_DOCS && pageInfo.docs.includes(DOC_TITLE), `${pageInfo.docs.length} 条：${pageInfo.docs.slice(0, 14).join('、')}`)
  await cdp.screenshot('01-home')

  /* --- 4. 点击《示例文档》查看正文 --- */
  log('\n[4] 点击文档树打开《示例文档》')
  await cdp.clickElement(treeDocRow(DOC_TITLE), `文档树《${DOC_TITLE}》`)
  await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图 .doc-html 出现')
  const readInfo = await cdp.evalJs(`(() => ({
    title: (document.querySelector('.doc-title') && document.querySelector('.doc-title').textContent || '').trim(),
    bodyText: (document.querySelector('.doc-body') && document.querySelector('.doc-body').innerText || '').slice(0, 4000),
    blocks: (document.querySelector('.doc-meta') && document.querySelector('.doc-meta').innerText || '').replace(/\\s+/g, ' '),
    hash: location.hash,
  }))()`)
  const readTextOk = READ_TEXT.every((t) => readInfo.bodyText.includes(t))
  ctx.readTextOk = readTextOk
  ctx.readTitle = readInfo.title
  ctx.readHash = readInfo.hash
  check('4-阅读', `主区标题 = 《${DOC_TITLE}》`, readInfo.title === DOC_TITLE, `实际=${JSON.stringify(readInfo.title)}`)
  check('4-阅读', `正文包含 ${READ_TEXT.map((t) => `「${t}」`).join('、')}`, readTextOk, `正文前 120 字：${readInfo.bodyText.replace(/\s+/g, ' ').slice(0, 120)}`)
  check('4-阅读', `hash 路由指向该文档`, readInfo.hash.includes(target.id), `hash=${readInfo.hash}`)
  await cdp.screenshot('02-doc-read')

  /* --- 5. 编辑 → 保存 → 磁盘校验 --- */
  log('\n[5] 编辑保存链路（真实 UI 交互）')
  let editOk = false
  try {
    await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」按钮')
    await cdp.waitFor(`!!document.querySelector('.ProseMirror')`, 15000, '编辑器 .ProseMirror 出现')
    const editorInfo = await cdp.evalJs(`(() => ({
      blocks: (document.querySelector('.zt-editor-foot') && document.querySelector('.zt-editor-foot').textContent || '').trim(),
      firstP: (document.querySelector('.ProseMirror p') && document.querySelector('.ProseMirror p').textContent || ''),
      count: document.querySelectorAll('.ProseMirror > *').length,
    }))()`)
    check('5-编辑', '进入编辑模式（TipTap 渲染 + 块数一致）', editorInfo.count === (docResp.blocks ?? []).length, `编辑器顶层节点=${editorInfo.count}，后端 blocks=${(docResp.blocks ?? []).length}，状态栏=${JSON.stringify(editorInfo.blocks)}`)
    check('5-编辑', `首个段落初始文本与后端一致`, editorInfo.firstP.includes('正文片段'), `实际=${JSON.stringify(editorInfo.firstP.slice(0, 60))}`)

    // 选中第一个段落的全部文本，再用真实输入管道替换
    const sel = await cdp.evalJs(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const p = pm && pm.querySelector('p');
      if (!p) return null;
      pm.focus();
      const range = document.createRange();
      range.selectNodeContents(p);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      return { text: p.textContent, selected: String(s).length };
    })()`)
    check('5-编辑', '首个段落已被选中（准备替换）', Boolean(sel) && sel.selected > 0, sel ? `选中 ${sel.selected} 字符：${JSON.stringify(sel.text.slice(0, 40))}` : '未找到段落')
    await cdp.insertText(NEW_TEXT)
    let typed = await cdp.evalJs(`(document.querySelector('.ProseMirror p') && document.querySelector('.ProseMirror p').textContent) || ''`)
    if (typed !== NEW_TEXT) {
      // 兜底：走浏览器 execCommand 输入管道
      await cdp.evalJs(`(() => { const p = document.querySelector('.ProseMirror p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, ${JSON.stringify(NEW_TEXT)}); return true })()`)
      typed = await cdp.evalJs(`(document.querySelector('.ProseMirror p') && document.querySelector('.ProseMirror p').textContent) || ''`)
      warn('CDP Input.insertText 未生效，已用 execCommand 兜底')
    }
    check('5-编辑', `首段文本已改为 ${NEW_TEXT}`, typed === NEW_TEXT, `实际=${JSON.stringify(typed.slice(0, 60))}`)
    await cdp.screenshot('03-edit-mode')

    const netBefore = cdp.network.length
    await cdp.clickElement(byText('.doc-actions button', '保存'), '「保存」按钮')
    await cdp.waitFor(`!!document.querySelector('.toast-ok')`, TOAST_TIMEOUT, '保存成功 toast(.toast-ok)')
    const toastInfo = await cdp.evalJs(`(() => ({
      ok: (document.querySelector('.toast-ok') && document.querySelector('.toast-ok').textContent || '').trim(),
      err: (document.querySelector('.toast-error') && document.querySelector('.toast-error').textContent || '').trim(),
    }))()`)
    check('5-保存', `出现保存成功反馈（.toast-ok = ${JSON.stringify(toastInfo.ok)}）`, toastInfo.ok.includes('已保存'), `toast-ok=${JSON.stringify(toastInfo.ok)}`)
    check('5-保存', '没有出现错误 toast（.toast-error）', !toastInfo.err, toastInfo.err ? `toast-error=${JSON.stringify(toastInfo.err)}` : '无')

    await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, '保存后回到阅读模式')
    const afterSaveText = await cdp.evalJs(`(document.querySelector('.doc-body') && document.querySelector('.doc-body').innerText || '').slice(0, 2000)`)
    check('5-保存', '保存后阅读视图立即显示新文本（后端回读）', afterSaveText.includes(NEW_TEXT), `含新文本=${afterSaveText.includes(NEW_TEXT)}`)
    await cdp.screenshot('04-after-save')

    // 抓取本次 save 的网络报文
    await sleep(400)
    const saveReqs = cdp.network.filter((n) => n.url.includes('/api/doc/save'))
    const lastSave = saveReqs[saveReqs.length - 1]
    ctx.saveReq = lastSave
    check('5-保存', '捕获到 POST api/doc/save 请求', Boolean(lastSave), lastSave ? `status=${lastSave.status} body=${clip(lastSave.postData, 160)}` : '未捕获')
    if (lastSave) {
      let body = null
      try {
        body = JSON.parse(lastSave.postData)
      } catch {
        /* 忽略 */
      }
      const blocksMeta = (body?.blocks ?? []).map((b) => ({ id: b.id, changed: b.changed, type: b.type }))
      ctx.saveBlocksMeta = blocksMeta
      check('5-保存', '请求体 box/id 与点击的文档一致', body?.box === target.box && body?.id === target.id, `box=${body?.box} id=${body?.id}`)
      check('5-保存', '块数组长度与后端一致', (body?.blocks ?? []).length === (docResp.blocks ?? []).length, `${(body?.blocks ?? []).length} vs ${(docResp.blocks ?? []).length}`)
      const changedIdx = blocksMeta.map((b, i) => (b.changed ? i : -1)).filter((i) => i >= 0)
      check('5-保存', '仅第一个块标记 changed:true，其余 changed:false（保真通道）', changedIdx.length === 1 && changedIdx[0] === 0, `changed 下标=${JSON.stringify(changedIdx)}；标记=${JSON.stringify(blocksMeta.map((b) => b.changed))}`)
      check('5-保存', '所有块都带原始块 ID（id 非 null）', blocksMeta.every((b) => typeof b.id === 'string' && b.id.length > 0), `ids=${JSON.stringify(blocksMeta.map((b) => b.id))}`)
      const pmFirst = body?.blocks?.[0]?.pm
      check(
        '5-保存',
        'changed:true 块的 pm 结构可被后端识别（type=paragraph + content[text]=新文本）',
        pmFirst?.type === 'paragraph' && JSON.stringify(pmFirst).includes(NEW_TEXT),
        clip(pmFirst, 300),
      )
    }
    editOk = true
  } catch (err) {
    check('5-编辑', '编辑保存链路整体执行', false, err instanceof Error ? err.message : String(err))
    bug(
      'UI 编辑保存链路中断',
      err instanceof Error ? err.message : String(err),
      `node ui/scripts/e2e-live.mjs`,
      '点击编辑 → 替换首段 → 点击保存 → toast 已保存',
      '链路在中途失败，见上方断言',
      'ui/src/views/doc.ts、ui/src/editor.ts（若属产品 bug）',
    )
  }

  /* --- 6. 磁盘独立校验 --- */
  log('\n[6] 磁盘 .sy 独立校验（不依赖前端）')
  if (editOk) {
    try {
      const syAfter = readSy(target.box, target.id)
      const newTextOnDisk = syAfter.raw.includes(NEW_TEXT)
      const idsSame = JSON.stringify(syBefore.ids) === JSON.stringify(syAfter.ids)
      const countSame = syBefore.ids.length === syAfter.ids.length
      const changedIndexes = []
      const maxLen = Math.max(syBefore.spans.length, syAfter.spans.length)
      for (let i = 0; i < maxLen; i++) {
        if (syBefore.spans[i] !== syAfter.spans[i]) changedIndexes.push(i)
      }
      const untouchedByteEqual = changedIndexes.every((i) => i === 0)
      const updatedRefreshed = Boolean(syAfter.updated) && syAfter.updated !== syBefore.updated
      const changedChild = syAfter.json.Children?.[0]
      const changedBlockShape = JSON.stringify({ Type: changedChild?.Type, ID: changedChild?.ID, text: changedChild?.Children?.[0]?.Data?.slice(0, 80) })

      ctx.disk = {
        path: syAfter.path,
        idsBefore: syBefore.ids,
        idsAfter: syAfter.ids,
        idsSame,
        countBefore: syBefore.ids.length,
        countAfter: syAfter.ids.length,
        updatedBefore: syBefore.updated,
        updatedAfter: syAfter.updated,
        updatedRefreshed,
        changedIndexes,
        untouchedByteEqual,
        newTextOnDisk,
        changedBlockShape,
        shaBefore: syBefore.sha,
        shaAfter: syAfter.sha,
      }

      check('6-磁盘', `(a) 新文本已落到 ${syAfter.path.replace(ROOT, '')}`, newTextOnDisk, `含 ${NEW_TEXT}=${newTextOnDisk}`)
      check('6-磁盘', '(b) 块 ID 与改前完全一致（含顺序）', idsSame, `改前前3=${JSON.stringify(syBefore.ids.slice(0, 3))} 改后前3=${JSON.stringify(syAfter.ids.slice(0, 3))}`)
      check('6-磁盘', '(c) 其余顶层块原文字节逐字节不变（仅第 0 块变化）', untouchedByteEqual, `变化下标=${JSON.stringify(changedIndexes)}，共 ${syAfter.spans.length} 个顶层块`)
      check('6-磁盘', '(d) 顶层块数量不变', countSame, `${syBefore.ids.length} → ${syAfter.ids.length}`)
      check('6-磁盘', '(e) Properties.updated 已刷新', updatedRefreshed, `${syBefore.updated} → ${syAfter.updated}`)
      check('6-磁盘', '落盘块结构正确（NodeParagraph + NodeText 新文本）', changedBlockShape.includes(NEW_TEXT) && changedBlockShape.includes('NodeParagraph'), changedBlockShape)
    } catch (err) {
      check('6-磁盘', '磁盘 .sy 校验执行', false, err instanceof Error ? err.message : String(err))
    }
  } else {
    skip('6-磁盘', '(a)-(e) 磁盘 .sy 校验')
  }

  /* --- 7. 无改动保存：字节保真 --- */
  log('\n[7] 无改动直接保存（sha256 必须不变）')
  if (editOk) {
    try {
      await nav(ctx.pageUrl ?? APP_URL, '重新加载页面')
      await cdp.waitFor(`!!document.querySelector('.tree-doc')`, 15000, '文档树重新渲染')
      const syNoopBefore = readSy(target.box, target.id)
      await cdp.clickElement(treeDocRow(DOC_TITLE), `文档树《${DOC_TITLE}》（第二次）`)
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图出现（第二次）')
      await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」按钮（第二次）')
      await cdp.waitFor(`!!document.querySelector('.ProseMirror')`, 15000, '编辑器出现（第二次）')
      await sleep(300)

      const netBefore = cdp.network.length
      await cdp.pressKey('s', { code: 'KeyS', vk: 83, modifiers: 2, text: '' }) // Ctrl+S
      await cdp.waitFor(`!!document.querySelector('.toast-ok')`, TOAST_TIMEOUT, 'Ctrl+S 保存成功 toast')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, 'Ctrl+S 后回到阅读模式')
      await sleep(500)

      const saveReqs2 = cdp.network.filter((n) => n.url.includes('/api/doc/save')).slice(-1)
      let flags = []
      let allFalse = false
      if (saveReqs2.length) {
        try {
          const body = JSON.parse(saveReqs2[0].postData)
          flags = (body.blocks ?? []).map((b) => b.changed)
          allFalse = flags.length > 0 && flags.every((f) => f === false)
        } catch {
          /* 忽略 */
        }
      }
      const syNoopAfter = readSy(target.box, target.id)
      const mtimeBefore = statSync(syNoopBefore.path).mtimeMs
      const mtimeAfter = statSync(syNoopAfter.path).mtimeMs
      ctx.noop = {
        shaBefore: syNoopBefore.sha,
        shaAfter: syNoopAfter.sha,
        byteEqual: syNoopBefore.sha === syNoopAfter.sha,
        changedFlags: flags,
        allFalse,
        mtimeBefore: new Date(mtimeBefore).toISOString(),
        mtimeAfter: new Date(mtimeAfter).toISOString(),
      }
      check('7-无改动保存', 'Ctrl+S 触发保存并成功（toast 已保存）', true, '')
      check('7-无改动保存', '前端全部按 changed:false 下发（保真通道）', allFalse, `changed 标记=${JSON.stringify(flags)}`)
      check('7-无改动保存', 'sha256 完全一致（后端未写盘）', syNoopBefore.sha === syNoopAfter.sha, `${syNoopBefore.sha} vs ${syNoopAfter.sha}`)
      check('7-无改动保存', '文件 mtime 未变化（无写盘副作用）', mtimeBefore === mtimeAfter, `${new Date(mtimeBefore).toISOString()} vs ${new Date(mtimeAfter).toISOString()}`)
    } catch (err) {
      check('7-无改动保存', '无改动保存链路', false, err instanceof Error ? err.message : String(err))
    }
  } else {
    skip('7-无改动保存', 'Ctrl+S 无改动保存字节保真')
  }

  /* --- 8. 搜索 --- */
  log('\n[8] 搜索并跳转（整篇命中 + 块级定位）')
  try {
    await cdp.clickElement(`document.querySelector('.search-input')`, '顶栏搜索框')
    await cdp.insertText('贷款')
    await cdp.pressKey('Enter', { code: 'Enter', vk: 13, text: '\r' })
    await cdp.waitFor(`!!document.querySelector('.search-hit') || !!document.querySelector('.empty-box')`, 15000, '搜索结果或空态出现')
    const s = await cdp.evalJs(`(() => ({
      pageTitle: (document.querySelector('.page-title') && document.querySelector('.page-title').textContent || '').trim(),
      meta: (document.querySelector('.page-meta') && document.querySelector('.page-meta').textContent || '').trim(),
      hits: document.querySelectorAll('.search-hit').length,
      first: (document.querySelector('.search-hit') && document.querySelector('.search-hit').innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
      firstTip: (document.querySelector('.search-hit') && document.querySelector('.search-hit').getAttribute('title') || ''),
      hash: location.hash,
    }))()`)
    ctx.search = { pageTitle: s.pageTitle, hits: s.hits, firstHit: s.first, tooltip: s.firstTip }
    const searchApi = await getJson(`${API}/search?q=${encodeURIComponent('贷款')}&limit=50`)
    const apiHits = searchApi.hits ?? []
    ctx.search.apiHits = apiHits.map((h) => ({ id: h.id, title: h.title, blockId: h.blockId, snippet: clip(h.snippet ?? '', 60) }))
    check('8-搜索', `搜索页标题 = ${JSON.stringify(s.pageTitle)}`, s.pageTitle.includes('搜索：贷款'), `meta=${s.meta}`)
    check('8-搜索', '搜索结果至少 1 条', s.hits >= 1, `命中 ${s.hits} 条；首条=${clip(s.first, 160)}`)
    // 契约：标题命中 = 整篇命中 → blockId 为空（思源的文档 ID 不是任何块的 data-node-id）
    check('8-搜索', '标题命中 blockId 为空（整篇命中）', apiHits.length > 0 && apiHits.every((h) => !h.blockId), `apiHits=${JSON.stringify(apiHits.slice(0, 2))}`)
    check('8-搜索', '整篇命中卡片 tooltip = 整篇命中，点击打开', s.firstTip === '整篇命中，点击打开', `实际=${JSON.stringify(s.firstTip)}`)
    if (s.hits >= 1) {
      await cdp.clickElement(`document.querySelector('.search-hit')`, '第一条搜索结果')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '跳转后阅读视图出现')
      const opened = await cdp.evalJs(`(document.querySelector('.doc-title') && document.querySelector('.doc-title').textContent || '').trim()`)
      const flash = await cdp.evalJs(`document.querySelectorAll('.block-flash').length`)
      ctx.search.openedTitle = opened
      ctx.search.hash = await cdp.evalJs(`location.hash`)
      check('8-搜索', `点击首条结果跳转到《${DOC_TITLE}》`, opened === DOC_TITLE, `实际打开=${JSON.stringify(opened)} hash=${ctx.search.hash}`)
      check('8-搜索', '整篇命中不带 ?block= 参数、不做块级高亮', !String(ctx.search.hash).includes('block=') && flash === 0, `hash=${ctx.search.hash} .block-flash=${flash}`)

      /* --- 8b. 正文命中 → 块级定位必须真的生效（步骤 [6] 改过的文本只存在于正文里）--- */
      await cdp.clickElement(`document.querySelector('.search-input')`, '顶栏搜索框（第二次）')
      await cdp.pressKey('a', { code: 'KeyA', vk: 65, modifiers: 2, text: '' }) // Ctrl+A 选中旧关键词
      await cdp.insertText(NEW_TEXT)
      await cdp.pressKey('Enter', { code: 'Enter', vk: 13, text: '\r' })
      await cdp.waitFor(
        `[...document.querySelectorAll('.search-hit')].some((el) => el.innerText.includes('E2E-联调'))`,
        15000,
        '正文命中搜索结果出现',
      )
      const b = await cdp.evalJs(`(() => {
        const el = document.querySelector('.search-hit')
        return { hits: document.querySelectorAll('.search-hit').length, tip: el && el.getAttribute('title') || '', text: el && el.innerText.replace(/\\s+/g, ' ').slice(0, 200) || '' }
      })()`)
      const bodyApi = await getJson(`${API}/search?q=${encodeURIComponent(NEW_TEXT)}&limit=50`)
      const bodyHits = bodyApi.hits ?? []
      const bodyHit = bodyHits[0] ?? {}
      ctx.search.bodyHit = { query: NEW_TEXT, hits: bodyHits.length, blockId: bodyHit.blockId, snippet: clip(bodyHit.snippet ?? '', 60), tooltip: b.tip, first: clip(b.text, 160) }
      check('8b-块定位', `正文命中「${NEW_TEXT}」且带块 ID`, b.hits >= 1 && !!bodyHit.blockId, `hits=${b.hits} blockId=${JSON.stringify(bodyHit.blockId)} api=${JSON.stringify(bodyHits.slice(0, 1))}`)
      if (bodyHit.blockId) {
        check('8b-块定位', '正文命中卡片 tooltip = 定位到块 <id>', b.tip === `定位到块 ${bodyHit.blockId}`, `实际=${JSON.stringify(b.tip)}`)
        await cdp.clickElement(`document.querySelector('.search-hit')`, '正文命中首条结果')
        await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '跳转后阅读视图出现')
        const hash2 = await cdp.evalJs(`location.hash`)
        const flash2 = await cdp.evalJs(`document.querySelectorAll('.block-flash').length`)
        const flashedId = await cdp.evalJs(`(() => { const el = document.querySelector('.block-flash'); return el ? (el.getAttribute('data-node-id') || el.getAttribute('data-id') || '') : '' })()`)
        ctx.search.bodyJump = { hash: hash2, flash: flash2, flashedId }
        check(
          '8b-块定位',
          '跳转带 ?block=<id> 且块级高亮真的命中',
          String(hash2).includes(`block=${bodyHit.blockId}`) && flash2 === 1 && flashedId === bodyHit.blockId,
          `hash=${hash2} .block-flash=${flash2} data-node-id=${JSON.stringify(flashedId)}`,
        )
      } else {
        bug(
          '正文命中没有返回块 ID',
          `搜索「${NEW_TEXT}」返回 ${bodyHits.length} 条但没有 blockId，块级定位无法生效`,
          `curl -s "${API}/search?q=${encodeURIComponent(NEW_TEXT)}&limit=5"`,
          '正文命中的 hit.blockId 应是该块的块 ID',
          JSON.stringify(bodyHits.slice(0, 1)),
          'internal/store/store.go Search',
        )
      }
    } else {
      bug(
        '搜索「贷款」没有结果',
        '顶栏搜索回车后页面无命中',
        `curl -s "${API}/search?q=贷款&limit=5"`,
        'hits 至少 1 条（示例文档）',
        `前端命中 ${s.hits} 条`,
        'ui/src/views/search.ts、internal/store/store.go Search',
      )
    }
  } catch (err) {
    check('8-搜索', '搜索链路执行', false, err instanceof Error ? err.message : String(err))
  }

  /* --- 9. 导出 zip 与磁盘比对 --- */
  log('\n[9] 导出思源 zip 并与磁盘逐字节比对')
  try {
    const res = await fetch(`${API}/export/siyuan?box=all`, withCookie())
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(EXPORT_ZIP, buf)
    const entries = readZip(buf)
    const syEntries = entries.filter((e) => e.name.endsWith('.sy'))
    const mismatch = []
    const missing = []
    let compared = 0
    let matched = 0
    for (const entry of entries) {
      const diskPath = join(USER_WS, entry.name)
      if (!existsSync(diskPath)) {
        missing.push(entry.name)
        continue
      }
      compared += 1
      if (readFileSync(diskPath).equals(entry.data)) matched += 1
      else mismatch.push(entry.name)
    }
    const utf8Ok = entries.every((e) => !/\uFFFD/.test(e.name) && (!/[^\x00-\x7f]/.test(e.name) || e.utf8Flag))
    ctx.exportSiYuan = { entries: entries.length, syCount: syEntries.length, compared, matched, allEqual: mismatch.length === 0, mismatch, missing, utf8Ok }
    check('9-导出', `api/export/siyuan?box=all 返回 zip（${entries.length} 条目，.sy ${syEntries.length} 个）`, res.status === 200 && syEntries.length === EXPECT_DOCS, `status=${res.status} 大小=${(buf.length / 1024).toFixed(0)}KB`)
    check(
      '9-导出',
      `zip 中每个条目都与磁盘逐字节一致（${matched}/${entries.length}）`,
      compared === entries.length && mismatch.length === 0 && missing.length === 0,
      missing.length
        ? `zip 里有磁盘上不存在的条目：${JSON.stringify(missing.slice(0, 6))}`
        : mismatch.length
          ? `不一致：${JSON.stringify(mismatch.slice(0, 6))}`
          : `全部一致，含编辑后的 ${target.id}.sy`,
    )
    check('9-导出', 'zip 条目名 UTF-8 正确（非 ASCII 名带 UTF-8 标志位）', utf8Ok, entries.map((e) => e.name).filter((n) => /[^\x00-\x7f]/.test(n)).slice(0, 3).join(' | '))
    if (mismatch.length) {
      bug(
        '导出 zip 内容与磁盘文件不一致',
        `导出与磁盘逐字节比对出现 ${mismatch.length} 个不一致条目`,
        `curl -s -o .test/e2e-live-export-siyuan.zip "${API}/export/siyuan?box=all" && node ui/scripts/e2e-live.mjs  # 见报告 3.7 节`,
        'zip 内字节 == 磁盘字节',
        JSON.stringify(mismatch.slice(0, 6)),
        'internal/store/store.go ExportSiYuan、internal/server/server.go handleExportSiyuan',
      )
    }

    const resMd = await fetch(`${API}/export/md?box=all`, withCookie())
    const mdBuf = Buffer.from(await resMd.arrayBuffer())
    writeFileSync(EXPORT_MD_ZIP, mdBuf)
    const mdEntries = readZip(mdBuf)
    const mdDocs = mdEntries.filter((e) => e.name.endsWith('.md') && !e.name.endsWith('/README.md'))
    const mdReadme = mdEntries.filter((e) => e.name.endsWith('/README.md'))
    let mdAssetCompared = 0
    let mdAssetMatched = 0
    const mdAssetMismatch = []
    for (const e of mdEntries) {
      if (!e.name.startsWith('assets/')) continue
      const diskPath = join(USER_WS, 'data', e.name)
      if (!existsSync(diskPath)) continue
      mdAssetCompared += 1
      if (readFileSync(diskPath).equals(e.data)) mdAssetMatched += 1
      else mdAssetMismatch.push(e.name)
    }
    ctx.exportMd = {
      entries: mdEntries.length,
      mdCount: mdEntries.length,
      docs: mdDocs.length,
      readme: mdReadme.length,
      assetCompared: mdAssetCompared,
      assetMatched: mdAssetMatched,
      assetMismatch: mdAssetMismatch,
      docTitles: mdDocs.map((e) => e.name.split('/').pop().replace(/\.md$/, '')).slice(0, 14),
    }
    check(
      '9-导出',
      `api/export/md?box=all 返回 zip：${mdDocs.length} 篇文档 .md + ${mdReadme.length} 个笔记本 README.md`,
      resMd.status === 200 && mdDocs.length === EXPECT_DOCS && mdReadme.length === EXPECT_BOXES,
      `status=${resMd.status} 条目=${mdEntries.length}（README.md 是每个笔记本一份目录页，因此 .md 总数 = 12 + 2）`,
    )
    check(
      '9-导出',
      `Markdown zip 里的 assets 与磁盘一致（${mdAssetMatched}/${mdAssetCompared}）`,
      mdAssetCompared >= EXPECT_STATS.assets && mdAssetMismatch.length === 0,
      mdAssetMismatch.length ? JSON.stringify(mdAssetMismatch.slice(0, 6)) : `zip 内 assets 数 = ${mdAssetCompared}，磁盘资源数 = ${EXPECT_STATS.assets}`,
    )
  } catch (err) {
    check('9-导出', '导出链路执行', false, err instanceof Error ? err.message : String(err))
  }

  /* --- 11. 图片：粘贴上传 + 排版保真（新建文档测，测完删掉）--- */
  log('\n[11] 图片粘贴上传（真实 ClipboardEvent 带 png）')
  if (editOk) {
    const imgDoc = { box: target.box, id: '' }
    let assetRef = ''
    try {
      const created = await postJson(`${API}/doc/create`, { box: imgDoc.box, title: 'E2E 图片测试' })
      imgDoc.id = created.data?.id ?? ''
      check('11-图片', '新建测试文档（走 API）', Boolean(imgDoc.id), `${created.status} ${created.text.slice(0, 120)}`)
      await nav(APP_URL, '回到首页')
      await cdp.waitFor(`!!document.querySelector('.tree-doc')`, 15000, '文档树渲染')
      await cdp.clickElement(treeDocRow('E2E 图片测试'), '文档树《E2E 图片测试》')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图出现')
      await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」按钮')
      await cdp.waitFor(`!!document.querySelector('.ProseMirror')`, 15000, '编辑器出现')
      await sleep(300)

      // 1×1 透明 PNG，构造真的 ClipboardEvent 粘进编辑器
      const pasted = await cdp.evalJs(`(() => {
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'e2e-paste.png', { type: 'image/png' }))
        const pm = document.querySelector('.ProseMirror')
        pm.focus()
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        const notCancelled = pm.dispatchEvent(ev)
        return { notCancelled, defaultPrevented: ev.defaultPrevented }
      })()`)
      check('11-图片', '粘贴事件被编辑器接管（已 preventDefault，不走浏览器默认插入）', pasted?.defaultPrevented === true, JSON.stringify(pasted))

      await cdp.waitFor(`!!document.querySelector('.ProseMirror img[src^="assets/"]')`, 25000, '编辑器内出现图片')
      const imgInfo = await cdp.evalJs(`(() => {
        const im = document.querySelector('.ProseMirror img[src^="assets/"]')
        if (!im) return null
        return {
          src: im.getAttribute('src'),
          alt: im.getAttribute('alt'),
          cls: im.className,
          separator: !!document.querySelector('.ProseMirror img.ProseMirror-separator'),
        }
      })()`)
      assetRef = String(imgInfo?.src || '')
      check('11-图片', `编辑器内图片 src 指向 assets/（${assetRef}）`, /^assets\/e2e-paste-\d{14}-[a-z0-9]{7}\.png$/.test(assetRef), JSON.stringify(imgInfo))
      check('11-图片', '图片 alt = 原文件名（去扩展名）', imgInfo?.alt === 'e2e-paste', JSON.stringify(imgInfo))
      check('11-图片', '编辑器内图片带 zt-image 类名（编辑器样式）', String(imgInfo?.cls || '').includes('zt-image'), JSON.stringify(imgInfo))
      // 进度提示是过渡态：插完 1.4s 后自己退场
      await cdp.waitFor(`!document.querySelector('.zt-upload')`, 6000, '上传提示自动清除')
      check('11-图片', '上传提示自动清除（不残留在编辑器里）', await cdp.evalJs(`!document.querySelector('.zt-upload')`), '')

      const uploadReqs = cdp.network.filter((n) => n.url.includes('/api/assets/upload'))
      check('11-图片', '走的是 POST api/assets/upload，且返回 200', uploadReqs.length >= 1 && uploadReqs.every((n) => n.status === 200), JSON.stringify(uploadReqs.map((n) => `${n.method} ${n.status}`)))
      await cdp.screenshot('11-paste-image')

      // 保存 → 磁盘校验 → 阅读视图
      await cdp.pressKey('s', { code: 'KeyS', vk: 83, modifiers: 2, text: '' })
      await cdp.waitFor(`!!document.querySelector('.toast-ok')`, TOAST_TIMEOUT, '保存成功 toast')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, '回到阅读模式')
      await sleep(400)

      const sy = readSy(imgDoc.box, imgDoc.id)
      const name = assetRef.split('/').pop()
      const assetPath = join(USER_WS, 'data', 'assets', name)
      const imgNode = (sy.json.Children ?? []).flatMap((c) => c.Children ?? []).find((n) => n.Type === 'NodeImage')
      const dest = (imgNode?.Children ?? []).find((n) => n.Type === 'NodeLinkDest')?.Data
      check('11-图片', '.sy 里写入 NodeImage，src 指向上传资源', Boolean(dest) && dest === assetRef, JSON.stringify({ dest, assetRef }))
      check('11-图片', '资源文件已落盘到 data/assets/', existsSync(assetPath), assetPath.replace(ROOT, ''))
      const readHtml = await cdp.evalJs(`document.querySelector('.doc-html')?.innerHTML ?? ''`)
      check('11-图片', '阅读视图渲染 <img src="assets/…">（经 /assets/ 路由可取到）', new RegExp(`<img[^>]+src="${assetRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(readHtml), readHtml.slice(0, 200))
      const served = await httpJson(`${BASE}${PREFIX}/${assetRef}`, {})
      check('11-图片', '图片 URL 能直接取到（HTTP 200）', served.status === 200, `status=${served.status}`)

      ctx.image = { doc: imgDoc.id, ref: assetRef, alt: imgInfo?.alt, uploadReqs: uploadReqs.length, syHasNodeImage: Boolean(dest), assetOnDisk: existsSync(assetPath), served: served.status }

      // 清理：删测试文档 + 删上传的资源
      await postJson(`${API}/doc/delete`, { box: imgDoc.box, id: imgDoc.id })
      const docGone = !existsSync(join(USER_WS, 'data', imgDoc.box, `${imgDoc.id}.sy`))
      let assetGone = true
      try {
        rmSync(assetPath)
        assetGone = !existsSync(assetPath)
      } catch {
        assetGone = false
      }
      check('11-图片', '清理：测试文档与上传资源已删除', docGone && assetGone, `doc=${docGone} asset=${assetGone}`)
    } catch (err) {
      check('11-图片', '图片粘贴上传链路执行', false, err instanceof Error ? err.message : String(err))
      if (imgDoc.id) {
        try {
          await postJson(`${API}/doc/delete`, { box: imgDoc.box, id: imgDoc.id })
          if (assetRef) rmSync(join(USER_WS, 'data', 'assets', assetRef.split('/').pop()), { force: true })
        } catch {
          /* 清理失败不影响结论 */
        }
      }
    }
  } else {
    skip('11-图片', '图片粘贴上传链路（编辑模式前置步骤失败）')
  }

  /* --- 11b. 图片行排版：思源 parent-style 宽度还原成「一行四张」--- */
  log('\n[11b] 图片行排版（阅读视图，《示例文稿》）')
  try {
    await nav(APP_URL, '回到应用首页')
    await cdp.waitFor(`!!document.querySelector('.tree-doc')`, 15000, '文档树渲染')
    // 直接走 hash 路由，不依赖文档树展开状态
    await cdp.evalJs(`location.hash = '#/doc/20250708095329-8rxeagf/20250604143405-29orui7'`)
    await cdp.waitFor(`!!document.querySelector('.doc-html .img-rows > p.img-row')`, 20000, '阅读视图出现图片行')
    // 图片是 loading=lazy，先滚到容器处再量
    await cdp.evalJs(`(() => { const b = document.querySelector('.doc-html .img-rows'); if (b) b.scrollIntoView({ block: 'center' }); return true })()`)
    await sleep(900)
    const layout = await cdp.evalJs(`(() => {
      const box = document.querySelector('.doc-html .img-rows')
      const rows = Array.prototype.slice.call(box.querySelectorAll(':scope > p.img-row'))
      const cr = box.getBoundingClientRect()
      return {
        container: Math.round(cr.width),
        html: box.innerHTML.slice(0, 3000),
        rows: rows.map((r) => {
          const rr = r.getBoundingClientRect()
          const im = r.querySelector('img')
          return {
            w: Math.round(rr.width), top: Math.round(rr.top), style: r.getAttribute('style'),
            imgW: im ? Math.round(im.getBoundingClientRect().width) : 0,
            loaded: im ? !!(im.complete && im.naturalWidth > 0) : false,
          }
        }),
      }
    })()`)
    const rows = layout?.rows ?? []
    const tops = new Set(rows.map((r) => r.top))
    check('11b-排版', `图片行容器含 ${rows.length} 个 img-row`, rows.length >= 4, JSON.stringify({ container: layout?.container, n: rows.length }))
    check('11b-排版', '每行正好 4 张（行数 = ceil(img-row 数 / 4)，未被块间空白挤成每行 3 张）', tops.size === Math.ceil(rows.length / 4), JSON.stringify({ tops: [...tops], 期望行数: Math.ceil(rows.length / 4), n: rows.length }))
    check('11b-排版', '单元格宽度 = 容器宽度的 1/4（parent-style width:25% 生效）', rows.length > 0 && rows.every((r) => Math.abs(r.w - layout.container / 4) <= 2), JSON.stringify({ 容器四分之一: Math.round(layout.container / 4), 实际: rows.map((r) => r.w) }))
    check('11b-排版', 'parent-style 的宽度写进了 style 属性', rows.every((r) => String(r.style || '').replace(/\s+/g, '').includes('width:25%')), JSON.stringify(rows.map((r) => r.style)))
    check('11b-排版', '图片真实加载成功（非 404 占位）', rows.every((r) => r.loaded), JSON.stringify(rows.map((r) => ({ imgW: r.imgW, loaded: r.loaded }))))
    check('11b-排版', '渲染出的 HTML 里块间无空白（防回归）', !/<\/p>\s+<p/.test(String(layout?.html || '')), /<\/p>\s+<p/.test(String(layout?.html || '')) ? '存在块间空白' : 'no')
    await cdp.screenshot('11b-image-rows')
  } catch (err) {
    check('11b-排版', '图片行排版检查', false, err instanceof Error ? err.message : String(err))
  }

  /* --- 12. 表格：插入/编辑/加删行列 → .sy NodeTable 往返 --- */
  log('\n[12] 表格（插入 + 编辑 + 加删行列 + .sy 往返）')
  if (editOk) {
    const tblDoc = { box: target.box, id: '' }
    const TBL_TEXT = `E2E表格${Date.now() % 100000}`
    try {
      const created = await postJson(`${API}/doc/create`, { box: tblDoc.box, title: 'E2E 表格测试' })
      tblDoc.id = created.data?.id ?? ''
      check('12-表格', '新建测试文档（走 API）', Boolean(tblDoc.id), `${created.status} ${created.text.slice(0, 120)}`)
      await nav(APP_URL, '回到首页')
      await cdp.waitFor(`!!document.querySelector('.tree-doc')`, 15000, '文档树渲染')
      await cdp.clickElement(treeDocRow('E2E 表格测试'), '文档树《E2E 表格测试》')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图出现')
      await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」按钮')
      await cdp.waitFor(`!!document.querySelector('.ProseMirror')`, 15000, '编辑器出现')
      await sleep(300)

      const tableShape = () =>
        cdp.evalJs(`(() => {
          const t = document.querySelector('.ProseMirror table')
          if (!t) return null
          const first = t.rows[0]
          return {
            rows: t.rows.length,
            cols: first ? first.cells.length : 0,
            th: t.querySelectorAll('th').length,
            barOpen: !!document.querySelector('.tb-tablebar.is-open'),
            text: (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          }
        })()`)

      await cdp.clickElement(byText('.zt-toolbar .tb-btn', '表格'), '工具条「表格」按钮')
      await cdp.waitFor(`document.querySelectorAll('.ProseMirror table').length === 1`, 8000, '编辑器内出现表格')
      const s1 = await tableShape()
      check('12-表格', '插入 3×3 表格，且首行是表头（th×3）', s1?.rows === 3 && s1?.cols === 3 && s1?.th === 3, JSON.stringify(s1))
      check('12-表格', '光标在表格内时表格操作条自动展开（.tb-tablebar.is-open）', s1?.barOpen === true, JSON.stringify(s1))
      await cdp.screenshot('12-table-insert')

      // 在第一个表头单元格里写字
      await cdp.evalJs(`(() => {
        const p = document.querySelector('.ProseMirror table th p, .ProseMirror table td p')
        if (!p) return false
        const r = document.createRange(); r.selectNodeContents(p)
        const s = getSelection(); s.removeAllRanges(); s.addRange(r)
        return true
      })()`)
      await cdp.insertText(TBL_TEXT)
      await sleep(200)
      const s2 = await tableShape()
      check('12-表格', `表头单元格写入 ${TBL_TEXT}`, String(s2?.text || '').includes(TBL_TEXT), JSON.stringify(s2))

      // 列/行增删（都作用在光标所在处）
      await cdp.clickElement(`document.querySelector('.tb-tablebar .tb-colAfter')`, '表格操作条「右侧插列」')
      await sleep(200)
      const s3 = await tableShape()
      check('12-表格', '右侧插列：4 列（表头也跟着变 4 个 th）', s3?.cols === 4 && s3?.th === 4, JSON.stringify(s3))

      await cdp.clickElement(`document.querySelector('.tb-tablebar .tb-rowAfter')`, '表格操作条「下方插行」')
      await sleep(200)
      const s4 = await tableShape()
      check('12-表格', '下方插行：4 行', s4?.rows === 4, JSON.stringify(s4))

      await cdp.clickElement(`document.querySelectorAll('.ProseMirror table tr')[3].cells[0]`, '刚插入的第 4 行（点进去再操作，跟真人一样）')
      await sleep(150)
      await cdp.clickElement(`document.querySelector('.tb-tablebar .tb-deleteRow')`, '表格操作条「删行」')
      await sleep(200)
      const s5 = await tableShape()
      check('12-表格', '删行：回到 3 行，表头与文字保留', s5?.rows === 3 && s5?.th === 4 && String(s5?.text || '').includes(TBL_TEXT), JSON.stringify(s5))

      // 插行/插列不会把光标带进新行，所以先点回表头行再切表头
      await cdp.clickElement(`document.querySelectorAll('.ProseMirror table tr')[0].cells[0]`, '第 1 行第 1 格（表头行）')
      await sleep(150)
      await cdp.clickElement(`document.querySelector('.tb-tablebar .tb-headerRow')`, '表格操作条「表头行」切掉')
      await sleep(200)
      const s6 = await tableShape()
      check('12-表格', '关掉表头行：th 变 0（td 接管）', s6?.th === 0, JSON.stringify(s6))

      await cdp.clickElement(`document.querySelector('.tb-tablebar .tb-headerRow')`, '表格操作条「表头行」切回')
      await sleep(200)
      const s7 = await tableShape()
      check('12-表格', '再开表头行：th 回到 4', s7?.th === 4, JSON.stringify(s7))
      await cdp.screenshot('12-table-edited')

      // 保存 → 阅读视图 → 磁盘 .sy
      await cdp.pressKey('s', { code: 'KeyS', vk: 83, modifiers: 2, text: '' })
      await cdp.waitFor(`!!document.querySelector('.toast-ok')`, TOAST_TIMEOUT, '保存成功 toast')
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, '回到阅读模式')
      await sleep(400)

      const cntType = (node, type) => {
        let n = node?.Type === type ? 1 : 0
        for (const c of node?.Children ?? []) n += cntType(c, type)
        return n
      }
      const syT = readSy(tblDoc.box, tblDoc.id)
      const tblNode = (syT.json.Children ?? [])[0]
      check('12-磁盘', '.sy 顶层块是 NodeTable（不是降级段落）', tblNode?.Type === 'NodeTable', JSON.stringify((syT.json.Children ?? []).map((n) => n.Type)))
      const head = (tblNode?.Children ?? []).find((n) => n.Type === 'NodeTableHead')
      check('12-磁盘', '表头行写在 NodeTableHead 下', Boolean(head) && cntType(head, 'NodeTableRow') === 1, JSON.stringify((tblNode?.Children ?? []).map((n) => n.Type)))
      check('12-磁盘', '行数 = 表头 1 + 表体 2', cntType(tblNode, 'NodeTableRow') === 3, `NodeTableRow=${cntType(tblNode, 'NodeTableRow')}`)
      check('12-磁盘', '单元格数 = 3 行 × 4 列', cntType(tblNode, 'NodeTableCell') === 12, `NodeTableCell=${cntType(tblNode, 'NodeTableCell')}`)
      check('12-磁盘', `表格文字 ${TBL_TEXT} 已落盘`, syT.raw.includes(TBL_TEXT), syT.raw.replace(/\s+/g, ' ').slice(0, 300))

      // 阅读视图 / 再次进编辑器（幂等）
      const readHtml = await cdp.evalJs(`document.querySelector('.doc-html')?.innerHTML ?? ''`)
      check('12-阅读', '阅读视图渲染 <table> + 表头 <th>', /<table/.test(readHtml) && /<thead/.test(readHtml) && /<th/.test(readHtml), readHtml.slice(0, 240))
      check('12-阅读', `阅读视图含表格文字 ${TBL_TEXT}`, readHtml.includes(TBL_TEXT), readHtml.replace(/\s+/g, ' ').slice(0, 240))
      const rdRows = await cdp.evalJs(`document.querySelectorAll('.doc-html table tr').length`)
      check('12-阅读', '阅读视图表格 3 行', rdRows === 3, `tr=${rdRows}`)
      await cdp.screenshot('12-table-read')

      await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」（二次进入）')
      await cdp.waitFor(`!!document.querySelector('.ProseMirror table')`, 15000, '二次进入编辑器出现表格')
      const s8 = await tableShape()
      check('12-表格', '二次进入编辑器：表格结构一致（幂等）', s8?.rows === 3 && s8?.cols === 4 && s8?.th === 4, JSON.stringify(s8))

      // 未改动的表格再保存：应走保真通道，磁盘 sha 不变
      const before = readSy(tblDoc.box, tblDoc.id)
      await cdp.pressKey('s', { code: 'KeyS', vk: 83, modifiers: 2, text: '' })
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, '无改动保存后回阅读模式')
      await sleep(300)
      const after = readSy(tblDoc.box, tblDoc.id)
      check('12-磁盘', '未改动的表格保存后 sha256 一致（表格不再被误改）', before.sha === after.sha, `${before.sha} vs ${after.sha}`)

      ctx.table = { doc: tblDoc.id, text: TBL_TEXT, rows: s8?.rows, cols: s8?.cols, th: s8?.th, syNodeTable: cntType(tblNode, 'NodeTableRow'), readHtml: readHtml.includes('<table') }
    } catch (err) {
      check('12-表格', '表格插入/编辑/保存链路执行', false, err instanceof Error ? err.message : String(err))
    } finally {
      if (tblDoc.id) {
        try {
          await postJson(`${API}/doc/delete`, { box: tblDoc.box, id: tblDoc.id })
          check('12-表格', '清理：测试文档已删除', !existsSync(join(USER_WS, 'data', tblDoc.box, `${tblDoc.id}.sy`)), '')
        } catch {
          /* 清理失败不影响结论 */
        }
      }
    }
  } else {
    skip('12-表格', '表格链路（编辑模式前置步骤失败）')
  }

  /* --- 13. 窄屏（手机）适配：抽屉 / 动作面板 / 触控尺寸 / 表格自滚 --- */
  log('\n[13] 窄屏适配（模拟 390×844 手机视口）')
  {
    const mobDoc = { box: target?.box ?? '', id: '' }
    const MOB_TEXT = `窄屏${Date.now() % 100000}`
    // 不可断行的长串：逼表格的 max-content 宽度超过手机视口
    const WIDE_TEXT = 'ZtNoteWideTableCell'.repeat(5)
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      })
      await sleep(250)

      const base = await cdp.evalJs(`(() => {
        const burger = document.querySelector('.topbar-burger')
        const more = document.querySelector('.topbar-more')
        const side = document.querySelector('.sidebar')
        const actions = document.querySelector('.topbar-actions')
        const sr = side.getBoundingClientRect()
        const row = document.querySelector('.tree-row')
        return {
          innerWidth: window.innerWidth,
          clientW: document.documentElement.clientWidth,
          innerHeight: window.innerHeight,
          clientH: document.documentElement.clientHeight,
          burger: burger ? getComputedStyle(burger).display : 'missing',
          more: more ? getComputedStyle(more).display : 'missing',
          sidePos: getComputedStyle(side).position,
          sideRight: Math.round(sr.right),
          sideTop: Math.round(sr.top),
          actions: getComputedStyle(actions).display,
          version: getComputedStyle(document.querySelector('.version')).display,
          rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
          searchFont: parseFloat(getComputedStyle(document.querySelector('.search-input')).fontSize),
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        }
      })()`)
      // innerWidth 是「视觉视口」：Chrome 在移动模拟下可能套一层 shrink-to-fit 缩放，故两者取其一
      check(
        '13-窄屏',
        '视口切到 390×844（布局视口 390）',
        base?.clientW === 390 || (base?.innerWidth ?? 0) === 390,
        JSON.stringify({ clientW: base?.clientW, innerWidth: base?.innerWidth }),
      )
      check('13-窄屏', '☰ / ⋯ 两个按钮在窄屏出现（宽屏隐藏）', base?.burger !== 'none' && base?.more !== 'none', JSON.stringify({ burger: base?.burger, more: base?.more }))
      check('13-窄屏', '侧栏离开文档流变抽屉：position:fixed 且收在屏幕外', base?.sidePos === 'fixed' && base?.sideRight <= 1 && base?.sideTop > 0, JSON.stringify({ position: base?.sidePos, right: base?.sideRight, top: base?.sideTop }))
      check('13-窄屏', '动作面板默认收起、版本号平时不占地方', base?.actions === 'none' && base?.version === 'none', JSON.stringify({ actions: base?.actions, version: base?.version }))
      check('13-窄屏', '目录行高 ≥38px、搜索框字号 ≥16px（好点、iOS 不缩放）', (base?.rowH ?? 0) >= 38 && (base?.searchFont ?? 0) >= 16, JSON.stringify({ rowH: base?.rowH, searchFont: base?.searchFont }))
      check('13-窄屏', '页面无横向溢出（scrollWidth ≤ innerWidth）', (base?.overflowX ?? 99) <= 1, `溢出 ${base?.overflowX}px`)

      /* ☰ 抽屉：打开 → 遮罩关闭 → 再打开 → 点文档自动收起 */
      await cdp.clickElement(`document.querySelector('.topbar-burger')`, '☰ 文档树按钮')
      await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().left >= -1`, 3000, '抽屉滑入完成')
      const opened = await cdp.evalJs(`(() => {
        const r = document.querySelector('.sidebar').getBoundingClientRect()
        return {
          cls: document.body.classList.contains('is-drawer-open'),
          left: Math.round(r.left), width: Math.round(r.width),
          mask: getComputedStyle(document.querySelector('.drawer-mask')).display,
        }
      })()`)
      check('13-抽屉', '点 ☰ 抽屉滑入屏内（左边缘≥0）且遮罩出现', opened?.cls === true && opened?.left >= 0 && opened?.width > 120 && opened?.mask === 'block', JSON.stringify(opened))
      await cdp.screenshot('13-drawer-open')

      await cdp.clickElement(`document.querySelector('.drawer-mask')`, '抽屉遮罩')
      await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().right <= 1`, 3000, '抽屉收起动画完成')
      const closed = await cdp.evalJs(`(() => {
        const r = document.querySelector('.sidebar').getBoundingClientRect()
        return {
          cls: document.body.classList.contains('is-drawer-open'),
          right: Math.round(r.right),
          mask: getComputedStyle(document.querySelector('.drawer-mask')).display,
        }
      })()`)
      check('13-抽屉', '点遮罩抽屉收起（回到屏外 + 遮罩隐藏）', closed?.cls === false && closed?.right <= 1 && closed?.mask === 'none', JSON.stringify(closed))

      /* ⋯ 动作面板 */
      await cdp.clickElement(`document.querySelector('.topbar-more')`, '⋯ 更多操作按钮')
      const moreOpen = await cdp.evalJs(`(() => {
        const a = document.querySelector('.topbar-actions')
        const r = a.getBoundingClientRect()
        const btns = Array.prototype.slice.call(a.querySelectorAll('.btn'))
        return {
          cls: document.body.classList.contains('is-more-open'),
          visible: getComputedStyle(a).display !== 'none' && r.height > 0,
          height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
          btnHeights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
          inlineCount: btns.filter((b) => getComputedStyle(b).display !== 'none').length,
        }
      })()`)
      check('13-面板', '点 ⋯ 动作面板展开（竖排面板 + 各动作按钮）', moreOpen?.cls === true && moreOpen?.visible === true && (moreOpen?.inlineCount ?? 0) >= 4, JSON.stringify(moreOpen))
      check('13-面板', '面板里的按钮高 ≥40px（手指好点）', (moreOpen?.btnHeights ?? []).every((v) => v >= 40), JSON.stringify(moreOpen?.btnHeights))
      check('13-面板', '面板整体在视口内（top 在顶栏下方、不越出屏幕）', (moreOpen?.top ?? 0) >= 46 && (moreOpen?.bottom ?? 9999) <= 844, JSON.stringify({ top: moreOpen?.top, bottom: moreOpen?.bottom }))
      await cdp.screenshot('13-more-open')

      /* 从抽屉里点文档：抽屉自动收起 + 正常打开 */
      await cdp.clickElement(`document.querySelector('.topbar-burger')`, '☰ 文档树按钮')
      await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().left >= -1`, 3000, '抽屉滑入完成')
      await cdp.clickElement(treeDocRow(DOC_TITLE), `抽屉里的《${DOC_TITLE}》`)
      await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图出现（窄屏）')
      await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().right <= 1`, 3000, '选中文档后抽屉收起')
      const afterPick = await cdp.evalJs(`(() => {
        const r = document.querySelector('.sidebar').getBoundingClientRect()
        return {
          drawer: document.body.classList.contains('is-drawer-open'),
          right: Math.round(r.right),
          title: (document.querySelector('.doc-title') || {}).textContent ? document.querySelector('.doc-title').textContent.trim() : '',
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          docBodyW: Math.round(document.querySelector('.doc-body').getBoundingClientRect().width),
        }
      })()`)
      check('13-抽屉', '点文档后抽屉自动收起并打开该文档', afterPick?.drawer === false && afterPick?.right <= 1 && afterPick?.title === DOC_TITLE, JSON.stringify(afterPick))
      check('13-阅读', '窄屏阅读视图无横向溢出（doc-body ≤ 视口）', (afterPick?.overflowX ?? 99) <= 1 && (afterPick?.docBodyW ?? 999) <= 390, JSON.stringify({ overflowX: afterPick?.overflowX, docBodyW: afterPick?.docBodyW }))

      /* 编辑区与表格（窄屏真插入、真输入、真保存） */
      if (editOk) {
        const created = await postJson(`${API}/doc/create`, { box: mobDoc.box, title: 'E2E 窄屏测试' })
        mobDoc.id = created.data?.id ?? ''
        check('13-编辑', '新建测试文档（走 API）', Boolean(mobDoc.id), `${created.status} ${created.text.slice(0, 120)}`)
        await nav(APP_URL, '回到首页')
        await cdp.waitFor(`!!document.querySelector('.tree-doc')`, 15000, '文档树渲染')
        // 窄屏下目录在抽屉里：先点 ☰ 拉开，再点文档（跟真人一样）
        await cdp.clickElement(`document.querySelector('.topbar-burger')`, '☰ 文档树按钮')
        await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().left >= -1`, 3000, '抽屉滑入完成')
        await cdp.clickElement(treeDocRow('E2E 窄屏测试'), '文档树《E2E 窄屏测试》')
        await cdp.waitFor(`document.querySelector('.sidebar').getBoundingClientRect().right <= 1`, 3000, '选中文档后抽屉收起')
        await cdp.waitFor(`!!document.querySelector('.doc-html')`, 15000, '阅读视图出现')
        await cdp.clickElement(byText('.doc-actions button', '编辑'), '「编辑」按钮')
        await cdp.waitFor(`!!document.querySelector('.ProseMirror')`, 15000, '编辑器出现')
        await sleep(300)

        const ed = await cdp.evalJs(`(() => {
          const tb = document.querySelectorAll('.zt-toolbar .tb-btn')
          const heights = Array.prototype.slice.call(tb).map((b) => Math.round(b.getBoundingClientRect().height))
          const cs = getComputedStyle(document.querySelector('.zt-editor-scroll'))
          return {
            btnCount: tb.length,
            minBtn: heights.length ? Math.min.apply(null, heights) : 0,
            editorFont: parseFloat(getComputedStyle(document.querySelector('.ProseMirror')).fontSize),
            maxH: cs.maxHeight, minH: cs.minHeight,
            innerHeight: window.innerHeight,
            clientH: document.documentElement.clientHeight,
            toolbarBottom: Math.round(document.querySelector('.zt-toolbar').getBoundingClientRect().bottom),
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
          }
        })()`)
        check('13-编辑', '工具条按钮高 ≥32px（触控目标）', (ed?.minBtn ?? 0) >= 32, JSON.stringify({ 共: ed?.btnCount, 最小: ed?.minBtn }))
        check('13-编辑', '编辑区字号 ≥16px（iOS 聚焦不缩放）', (ed?.editorFont ?? 0) >= 16, String(ed?.editorFont))
        // 视觉行高按视口算：100dvh - 210px（不是桌面端的 100vh - 300px）；用布局视口高比对，容差 2px
        const refH = ed?.clientH || ed?.innerHeight || 0
        check(
          '13-编辑',
          '编辑区高度按手机视口算（100dvh-210px）且下限 240px',
          Math.abs(parseFloat(String(ed?.maxH)) - (refH - 210)) <= 2 && ed?.minH === '240px',
          JSON.stringify({ maxH: ed?.maxH, 期望: `${refH - 210}px`, minH: ed?.minH, clientH: ed?.clientH, innerHeight: ed?.innerHeight }),
        )
        check('13-编辑', '工具条在首屏内（bottom < 视口高）', (ed?.toolbarBottom ?? 9999) < 844, String(ed?.toolbarBottom))

        await cdp.clickElement(byText('.zt-toolbar .tb-btn', '表格'), '窄屏工具条「表格」按钮')
        await cdp.waitFor(`document.querySelectorAll('.ProseMirror table').length === 1`, 8000, '窄屏下插入表格')
        // 往第一格塞长文本：逼表格超过视口宽，看它自己滚还是把整页撑宽
        await cdp.evalJs(`(() => {
          const p = document.querySelector('.ProseMirror table th p, .ProseMirror table td p')
          if (!p) return false
          const r = document.createRange(); r.selectNodeContents(p)
          const s = getSelection(); s.removeAllRanges(); s.addRange(r)
          return true
        })()`)
        await cdp.insertText(MOB_TEXT + WIDE_TEXT)
        await sleep(250)
        const tbl = await cdp.evalJs(`(() => {
          const t = document.querySelector('.ProseMirror table')
          const r = t.getBoundingClientRect()
          const cs = getComputedStyle(t)
          return {
            display: cs.display, overflowX: cs.overflowX,
            rows: t.rows.length, cols: t.rows[0] ? t.rows[0].cells.length : 0,
            boxW: Math.round(r.width), scrollW: Math.round(t.scrollWidth), clientW: Math.round(t.clientWidth),
            pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
            text: (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          }
        })()`)
        check('13-表格', '窄屏插入 3×3 表格成功', tbl?.rows === 3 && tbl?.cols === 3, JSON.stringify({ rows: tbl?.rows, cols: tbl?.cols }))
        check('13-表格', '单元格可点可输入（display:block 不影响编辑）', String(tbl?.text || '').includes(MOB_TEXT), JSON.stringify(tbl?.text))
        check(
          '13-表格',
          '超宽表格自己框里横滑（scrollW > clientW），表格盒宽仍不超视口',
          (tbl?.scrollW ?? 0) > (tbl?.clientW ?? 0) && (tbl?.boxW ?? 999) <= 390 && tbl?.display === 'block' && tbl?.overflowX === 'auto',
          JSON.stringify({ boxW: tbl?.boxW, scrollW: tbl?.scrollW, clientW: tbl?.clientW, display: tbl?.display, overflowX: tbl?.overflowX }),
        )
        check('13-表格', '表格撑宽时整页仍无横向溢出', (tbl?.pageOverflowX ?? 99) <= 1, `溢出 ${tbl?.pageOverflowX}px`)
        await cdp.screenshot('13-mobile-table')

        // 保存（窄屏下 Ctrl+S）并核对落盘
        await cdp.pressKey('s', { code: 'KeyS', vk: 83, modifiers: 2, text: '' })
        await cdp.waitFor(`!!document.querySelector('.doc-html')`, TOAST_TIMEOUT, '窄屏保存后回阅读模式')
        await sleep(250)
        const syM = readSy(mobDoc.box, mobDoc.id)
        check('13-磁盘', '窄屏编辑的表格落到 .sy（NodeTable + 文字）', syM.json?.Children?.[0]?.Type === 'NodeTable' && syM.raw.includes(MOB_TEXT), JSON.stringify((syM.json?.Children ?? []).map((n) => n.Type)))
        ctx.mobile = { opened, moreOpen, ed, tbl, sy: syM.json?.Children?.[0]?.Type }
      } else {
        skip('13-编辑', '窄屏编辑/表格链路（编辑模式前置步骤失败）')
      }
    } catch (err) {
      check('13-窄屏', '窄屏适配链路执行', false, err instanceof Error ? err.message : String(err))
    } finally {
      try {
        await cdp.send('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* 忽略 */
      }
      if (mobDoc.id) {
        try {
          await postJson(`${API}/doc/delete`, { box: mobDoc.box, id: mobDoc.id })
          check('13-窄屏', '清理：测试文档已删除', !existsSync(join(USER_WS, 'data', mobDoc.box, `${mobDoc.id}.sy`)), '')
        } catch {
          /* 清理失败不影响结论 */
        }
      }
    }
  }

  /* --- 10. 前端异常汇总 --- */
  log('\n[10] 前端异常汇总')
  await sleep(300)
  ctx.jsErrors = { page: cdp.pageErrors, console: cdp.consoleErrors, log: cdp.logErrors }
  ctx.apiTraffic = cdp.network.map((n) => ({ method: n.method, url: n.url.replace(BASE, ''), status: n.status }))
  check('10-异常', '无未捕获 JS 异常（pageerror）', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '))
  check('10-异常', '无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '))
  // 404（故意探不存在的资源）与 401（PIN 门故意探 api/tree）都不算异常
  const logErrNon404 = cdp.logErrors.filter((t) => !/404/.test(t) && !(/401/.test(t) && /api\/tree/.test(t)))
  if (cdp.logErrors.length) warn(`浏览器日志有 ${cdp.logErrors.length} 条 error 级记录（含预期内的 404 / PIN 门 401）：${cdp.logErrors.slice(0, 4).join(' | ')}`)
  check('10-异常', '浏览器日志无 404 以外的 error（除 PIN 门故意探的 401）', logErrNon404.length === 0, logErrNon404.slice(0, 3).join(' | '))
  if (cdp.pageErrors.length || cdp.consoleErrors.length) {
    bug(
      '页面出现未捕获 JS 异常/console.error',
      `pageerror=${cdp.pageErrors.length}，console.error=${cdp.consoleErrors.length}`,
      'node ui/scripts/e2e-live.mjs',
      '0 条',
      cdp.pageErrors.concat(cdp.consoleErrors).slice(0, 4).join(' | ').slice(0, 800),
      'ui/src/**（按堆栈定位）',
    )
  }
}

/* ================= 数据查找 ================= */

function findDoc(notebooks, title) {
  for (const nb of notebooks) {
    const hit = walkDocs(nb.docs ?? [], nb, title)
    if (hit) return hit
  }
  return null
}

function walkDocs(docs, nb, title) {
  for (const d of docs) {
    if ((d.title ?? '') === title) return { id: d.id, box: nb.id, boxName: nb.name }
    const child = walkDocs(d.children ?? [], nb, title)
    if (child) return child
  }
  return null
}

/* ================= 收尾 ================= */

function cleanup() {
  if (ctx.cdp) ctx.cdp.close()
  stopShim()
  if (ctx.chrome && !ctx.chrome.killed) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(ctx.chrome.pid), '/t', '/f'], { stdio: 'ignore' })
      else ctx.chrome.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
  if (ctx.profile) {
    try {
      rmSync(ctx.profile, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  killServer()
}

/* ================= 入口 ================= */

let exitCode = 0
try {
  await main()
} catch (err) {
  ctx.fatal = ctx.fatal || (err instanceof Error ? err.message : String(err))
  check('0-致命', '主流程执行', false, ctx.fatal.slice(0, 500))
} finally {
  try {
    cleanup()
  } catch {
    /* 忽略 */
  }
  const failCount = checks.filter((c) => !c.ok && !c.skipped).length
  exitCode = failCount > 0 ? 1 : 0
  try {
    const report = buildReport(ctx)
    writeFileSync(REPORT, report)
    log(`\n报告已写入：${REPORT}`)
  } catch (err) {
    log(`报告写入失败：${err instanceof Error ? err.message : String(err)}`)
    exitCode = 1
  }
  log(`\n结果：${checks.filter((c) => c.ok).length} 通过 / ${failCount} 失败 / ${checks.filter((c) => c.skipped).length} 跳过；退出码 ${exitCode}`)
  if (bugs.length) {
    log(`发现 ${bugs.length} 个问题/契约不一致（详见报告第 4 节）`)
  }
  process.exit(exitCode)
}
