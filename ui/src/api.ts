// 所有请求一律用相对路径：页面可能挂在 /app/zt-note/ 下，也可能是 http://host:8765/。
// 因为用 hash 路由，document 的目录部分不会变，相对路径始终解析到正确的网关前缀。

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 会话失效（锁定 / 后端重启）时的回调：app 层用它回到 PIN 屏。 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

/** 是否有请求因为未解锁而失败（避免 401 风暴时反复弹解锁屏）。 */
let gateBusy = false

export function setGateBusy(busy: boolean): void {
  gateBusy = busy
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (!res.ok || obj.ok === false) {
    const msg =
      typeof obj.error === 'string' && obj.error
        ? obj.error
        : text
          ? text.slice(0, 300)
          : `请求失败（HTTP ${res.status}）`
    // 401：会话没了（被锁定 / 后端重启 / Cookie 过期），交给 app 层重新上锁
    if (res.status === 401 && !gateBusy) onUnauthorized?.()
    throw new ApiError(msg, res.status)
  }
  if (data === null && text) {
    // 后端返回了非 JSON，按原文报错（避免静默吞掉网关的 HTML 错误页）
    throw new ApiError(`响应不是 JSON：${text.slice(0, 300)}`, res.status)
  }
  return obj
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json', ...authHeader() },
    credentials: 'same-origin',
  })
  return (await parse(res)) as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeader() },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  })
  return (await parse(res)) as T
}

/** 上传文件（multipart）。onProgress 给百分比 0-100。 */
export function apiUpload<T>(
  path: string,
  file: File,
  field = 'file',
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const form = new FormData()
    form.append(field, file, file.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path, true)
    xhr.responseType = 'text'
    const token = tokenValue()
    if (token) xhr.setRequestHeader('X-Zt-Token', token)
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onerror = () => reject(new ApiError('网络错误：上传失败', 0))
    xhr.onload = () => {
      let data: Record<string, unknown> = {}
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {}
      } catch {
        reject(new ApiError(`响应不是 JSON：${String(xhr.responseText).slice(0, 300)}`, xhr.status))
        return
      }
      if (xhr.status >= 400 || data.ok === false) {
        const msg = typeof data.error === 'string' && data.error ? data.error : `上传失败（HTTP ${xhr.status}）`
        reject(new ApiError(msg, xhr.status))
        return
      }
      resolve(data as T)
    }
    xhr.send(form)
  })
}

/** 便捷封装 */
export const api = {
  health: () => apiGet<import('./types').HealthResp>('api/health'),
  session: () => apiGet<import('./types').SessionResp>('api/session'),
  pinSetup: (pin: string) => apiPost<import('./types').PinResp>('api/pin/setup', { pin }),
  pinUnlock: (pin: string) => apiPost<import('./types').PinResp>('api/pin/unlock', { pin }),
  pinLock: () => apiPost<{ locked: boolean }>('api/pin/lock'),
  pinChange: (oldPin: string, newPin: string) =>
    apiPost<import('./types').PinResp>('api/pin/change', { old: oldPin, new: newPin }),
  /** 撤销其它设备上的解锁（本机换一枚新会话继续用） */
  pinRevoke: () => apiPost<import('./types').PinResp>('api/pin/revoke'),
  tree: () => apiGet<{ notebooks: import('./types').Notebook[] }>('api/tree'),
  doc: (box: string, id: string) =>
    apiGet<import('./types').DocResp>(`api/doc?box=${encodeURIComponent(box)}&id=${encodeURIComponent(id)}`),
  search: (q: string, limit = 50) =>
    apiGet<{ hits: import('./types').SearchHit[] }>(
      `api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  createDoc: (box: string, title: string, parentId?: string) =>
    apiPost<{ id: string }>('api/doc/create', parentId ? { box, title, parentId } : { box, title }),
  renameDoc: (box: string, id: string, title: string) => apiPost('api/doc/rename', { box, id, title }),
  deleteDoc: (box: string, id: string) => apiPost('api/doc/delete', { box, id }),
  createNotebook: (name: string) => apiPost<{ id: string }>('api/notebook/create', { name }),
  saveDoc: (box: string, id: string, blocks: import('./types').SaveBlock[]) =>
    apiPost('api/doc/save', { box, id, blocks: stripTokens(blocks) }),
  importPath: (path: string) =>
    apiPost<import('./types').ImportResp>('api/import/path', { path }),
  importUpload: (file: File, onProgress?: (p: number) => void) =>
    apiUpload<import('./types').ImportResp>('api/import/upload', file, 'file', onProgress),
}

/** 导出：直接触发浏览器下载（相对路径同样有效）。 */
export function exportUrl(format: 'siyuan' | 'md', box: string): string {
  return withToken(`api/export/${format}?box=${encodeURIComponent(box)}`)
}

export function triggerDownload(url: string): void {
  window.location.href = url
}

/* ---------------- 会话令牌的多通道携带 ---------------- */
//
// 为什么需要：飞牛 App 把应用嵌在 WebView / iframe 里，Cookie 可能被当第三方拦掉或存不下。
// 只靠 Cookie 的话，表现就是「PIN 明明输对了，却一直让重输」。所以令牌同时走三条路：
//   1) Cookie      —— 浏览器默认通道（后端照旧下发，HttpOnly，JS 读不到）
//   2) 请求头      —— 本文件所有 fetch/XHR 都带 X-Zt-Token（WebView 里这条最可靠）
//   3) 只读 URL 参数 ?t= —— 图片 src、导出下载这类发不了请求头的场景
// 令牌绑定网关身份（uid），换账号后后端会拒掉旧令牌并在 /api/session 里给出 reason。

/** localStorage 里存 {uid, token}：记住是谁的令牌，换账号不会串用。 */
const tokenKey = 'ztnote.token'
let memoryToken: { uid: string; token: string } | null = null

/** 当前会话令牌（内存优先，其次 localStorage）。 */
export function readToken(): { uid: string; token: string } | null {
  if (memoryToken) return memoryToken
  try {
    const raw = window.localStorage.getItem(tokenKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { uid?: unknown; token?: unknown }
    if (typeof parsed?.token !== 'string' || !parsed.token) return null
    memoryToken = { uid: typeof parsed.uid === 'string' ? parsed.uid : '', token: parsed.token }
    return memoryToken
  } catch {
    return null
  }
}

export function tokenValue(): string {
  return readToken()?.token ?? ''
}

/** 解锁成功后把令牌存下来；localStorage 不可用（隐私模式/配额）时只留在内存里，
 *  本页照常能用，只是刷新后要重新输 PIN。 */
export function saveToken(uid: string, token: string): void {
  if (!token) return
  // uid 可以为空（调用处只拿到新令牌），那就沿用先前记着的那一个
  memoryToken = { uid: uid || readToken()?.uid || '', token }
  try {
    window.localStorage.setItem(tokenKey, JSON.stringify(memoryToken))
  } catch {
    /* 存不下就算了，内存里那份仍然有效 */
  }
}

export function clearToken(): void {
  memoryToken = null
  try {
    window.localStorage.removeItem(tokenKey)
  } catch {
    /* 忽略 */
  }
}

/** 请求头通道：所有接口调用都带上（服务端认 X-Zt-Token，与 Cookie 等价）。 */
function authHeader(): Record<string, string> {
  const token = tokenValue()
  return token ? { 'X-Zt-Token': token } : {}
}

/** 把令牌挂到 URL 上（只读：图片 src、导出下载）。重复调用不会叠出两个 t。 */
export function withToken(url: string): string {
  const token = tokenValue()
  if (!token) return url
  const base = dropTokenParts(url, token)
  return `${base}${base.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`
}

/** 去掉 URL 上「属于当前令牌」的 ?t= 参数（只认自己的令牌，免得改动外链里同名的参数）。 */
function dropTokenParts(url: string, token: string): string {
  if (!token) return url
  const at = url.indexOf('?')
  if (at < 0) return url
  const head = url.slice(0, at)
  const parts = url
    .slice(at + 1)
    .split('&')
    .filter((p) => p !== `t=${token}` && p !== `t=${encodeURIComponent(token)}`)
  return parts.length ? `${head}?${parts.join('&')}` : head
}

/** 存盘前清掉正文里的令牌（图片 src 在渲染时会临时带上 ?t=，不能写进笔记）。 */
function stripTokens<T>(value: T): T {
  if (typeof value === 'string') return stripToken(value) as unknown as T
  if (Array.isArray(value)) return value.map(stripTokens) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripTokens(v)
    return out as unknown as T
  }
  return value
}

/** 去掉单个 URL 上的令牌参数。 */
function stripToken(url: string): string {
  return dropTokenParts(url, tokenValue())
}

/** 外链 / data: / blob: 这类地址不用管（只有本站资源才需要令牌）。 */
function isLocalAsset(src: string): boolean {
  if (!src) return false
  if (src.startsWith('data:') || src.startsWith('blob:')) return false
  if (src.startsWith('//')) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(src)
}

/**
 * 给容器里的图片地址补上会话令牌。
 *
 * 图片是浏览器自己发起的子资源请求，带不了自定义请求头，Cookie 被 WebView
 * 拦掉时就会全部变成碎图——这里把令牌挂到 ?t= 上。
 * 只动本站相对地址，外链与 data: 不碰。watch=true 时盯着后续新增的图片
 * （粘贴/上传后立刻显示），存盘时 api.saveDoc 会把令牌清掉。
 */
export function pinAssetTokens(root: HTMLElement, watch = false): void {
  const pin = (): void => {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? ''
      if (!isLocalAsset(src)) return
      const next = withToken(src)
      if (next !== src) img.setAttribute('src', next)
    })
  }
  pin()
  if (!watch || !tokenValue()) return
  // 自己写回的值与当前值相同时不再写，所以不会自我循环
  new MutationObserver(pin).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  })
}

/**
 * 探测当前会话：不带任何笔记数据，只问「身份是谁、解锁了没、没解锁是为什么」。
 * 解锁成功后用它验证一遍——Cookie 丢掉时能当场给出原因，而不是让用户反复输 PIN。
 * 网络不通返回 null，由调用方决定怎么提示。
 */
export async function probeSession(): Promise<import('./types').SessionResp | null> {
  try {
    const res = await fetch('api/session', {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeader() },
      credentials: 'same-origin',
    })
    const data = (await res.json().catch(() => null)) as unknown
    if (!data || typeof data !== 'object') return null
    return data as import('./types').SessionResp
  } catch {
    return null
  }
}
