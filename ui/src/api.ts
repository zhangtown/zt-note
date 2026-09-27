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
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  return (await parse(res)) as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
    apiPost('api/doc/save', { box, id, blocks }),
  importPath: (path: string) =>
    apiPost<import('./types').ImportResp>('api/import/path', { path }),
  importUpload: (file: File, onProgress?: (p: number) => void) =>
    apiUpload<import('./types').ImportResp>('api/import/upload', file, 'file', onProgress),
}

/** 导出：直接触发浏览器下载（相对路径同样有效）。 */
export function exportUrl(format: 'siyuan' | 'md', box: string): string {
  return `api/export/${format}?box=${encodeURIComponent(box)}`
}

export function triggerDownload(url: string): void {
  window.location.href = url
}
