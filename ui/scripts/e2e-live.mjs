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

async function httpJson(url, init) {
  const res = await fetch(url, init)
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
  serverProc = spawn(EXE, ['-workspace', WS, '-addr', `${HOST}:${PORT}`, '-prefix', PREFIX], {
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
  const path = join(WS, 'data', box, `${id}.sy`)
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
  lines.push(`- 工作区：\`${WS}\`（每次运行重建；导入源：\`${SIYUAN_DATA}\`）`)
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
  lines.push(`后端命令 = ${EXE} -workspace .test/uiws -addr ${HOST}:${PORT} -prefix ${PREFIX}`)
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
  for (const [k, v] of Object.entries(EXPECT_STATS)) {
    check(
      '2-stats',
      `stats.${k} === ${v}`,
      stats[k] === v,
      `实际 ${JSON.stringify(stats[k])}（全量 stats=${JSON.stringify(stats)}）`,
    )
  }

  const tree = await getJson(`${API}/tree`)
  const boxNames = (tree.notebooks ?? []).map((nb) => nb.name)
  const target = findDoc(tree.notebooks ?? [], DOC_TITLE)
  check('2-数据', `文档树含 2 个笔记本：${JSON.stringify(boxNames)}`, (tree.notebooks ?? []).length === 2, `${(tree.notebooks ?? []).length} 个：${boxNames.join('、')}`)
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
  let strictShell = false
  try {
    strictShell = Boolean(await cdp.waitFor(`!!document.querySelector('.shell')`, 9000, '.shell 布局出现（严格模式）'))
  } catch {
    strictShell = false
  }
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
        '.test/ztnote.exe -workspace .test/uiws -addr 127.0.0.1:8801 -prefix /app/zt-note',
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
  check('3-树', `文档树渲染 2 个笔记本且含 笔记本A / 示例笔记本`, pageInfo.notebooks.length === 2 && pageInfo.notebooks.includes('笔记本A') && pageInfo.notebooks.includes('示例笔记本'), JSON.stringify(pageInfo.notebooks))
  check('3-树', `笔记本展开后渲染 12 个文档条目且含《${DOC_TITLE}》`, pageInfo.docs.length === 12 && pageInfo.docs.includes(DOC_TITLE), `${pageInfo.docs.length} 条：${pageInfo.docs.slice(0, 14).join('、')}`)
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
    const res = await fetch(`${API}/export/siyuan?box=all`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(EXPORT_ZIP, buf)
    const entries = readZip(buf)
    const syEntries = entries.filter((e) => e.name.endsWith('.sy'))
    const mismatch = []
    const missing = []
    let compared = 0
    let matched = 0
    for (const entry of entries) {
      const diskPath = join(WS, entry.name)
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
    check('9-导出', `api/export/siyuan?box=all 返回 zip（${entries.length} 条目，.sy ${syEntries.length} 个）`, res.status === 200 && syEntries.length === EXPECT_STATS.docs, `status=${res.status} 大小=${(buf.length / 1024).toFixed(0)}KB`)
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

    const resMd = await fetch(`${API}/export/md?box=all`)
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
      const diskPath = join(WS, 'data', e.name)
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
      resMd.status === 200 && mdDocs.length === EXPECT_STATS.docs && mdReadme.length === EXPECT_STATS.notebooks,
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
      const assetPath = join(WS, 'data', 'assets', name)
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
      const docGone = !existsSync(join(WS, 'data', imgDoc.box, `${imgDoc.id}.sy`))
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
          if (assetRef) rmSync(join(WS, 'data', 'assets', assetRef.split('/').pop()), { force: true })
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

  /* --- 10. 前端异常汇总 --- */
  log('\n[10] 前端异常汇总')
  await sleep(300)
  ctx.jsErrors = { page: cdp.pageErrors, console: cdp.consoleErrors, log: cdp.logErrors }
  ctx.apiTraffic = cdp.network.map((n) => ({ method: n.method, url: n.url.replace(BASE, ''), status: n.status }))
  check('10-异常', '无未捕获 JS 异常（pageerror）', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '))
  check('10-异常', '无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '))
  const logErrNon404 = cdp.logErrors.filter((t) => !/404/.test(t))
  if (cdp.logErrors.length) warn(`浏览器日志有 ${cdp.logErrors.length} 条 error 级记录（含 404）：${cdp.logErrors.slice(0, 4).join(' | ')}`)
  check('10-异常', '浏览器日志无 404 以外的 error', logErrNon404.length === 0, logErrNon404.slice(0, 3).join(' | '))
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
