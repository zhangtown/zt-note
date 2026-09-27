// hash 路由：#/ 、#/doc/<box>/<id>[?mode=edit&block=xxx] 、#/search?q=xxx 、#/import
import type { CurrentSelection } from './types'

export type Route =
  | { name: 'home' }
  | { name: 'doc'; box: string; id: string; mode: 'read' | 'edit'; block: string }
  | { name: 'search'; q: string }
  | { name: 'import' }

export function parseHash(hash: string): Route {
  const raw = (hash || '').replace(/^#/, '')
  const [pathPart, queryPart] = raw.split('?')
  const segs = pathPart
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s))
  const query = new URLSearchParams(queryPart ?? '')
  if (segs[0] === 'doc' && segs.length >= 3) {
    return {
      name: 'doc',
      box: segs[1],
      id: segs[2],
      mode: query.get('mode') === 'edit' ? 'edit' : 'read',
      block: query.get('block') ?? '',
    }
  }
  if (segs[0] === 'search') return { name: 'search', q: query.get('q') ?? '' }
  if (segs[0] === 'import') return { name: 'import' }
  return { name: 'home' }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'doc': {
      const q = new URLSearchParams()
      if (route.mode === 'edit') q.set('mode', 'edit')
      if (route.block) q.set('block', route.block)
      const suffix = q.toString()
      return `#/doc/${encodeURIComponent(route.box)}/${encodeURIComponent(route.id)}${suffix ? `?${suffix}` : ''}`
    }
    case 'search':
      return `#/search${route.q ? `?q=${encodeURIComponent(route.q)}` : ''}`
    case 'import':
      return '#/import'
    default:
      return '#/'
  }
}

/** 是否指向同一份文档（同文档内切「读/写」模式不触发离开确认）。 */
export function sameDoc(a: Route, b: Route): boolean {
  if (a.name === 'doc' && b.name === 'doc') return a.box === b.box && a.id === b.id
  return a.name === b.name
}

export function selectionOf(route: Route): CurrentSelection | null {
  if (route.name === 'doc') return { kind: 'doc', box: route.box, id: route.id }
  return null
}

type Handler = (route: Route) => void
/** 返回 false 表示拦下本次跳转（守卫自己负责后续交互）。 */
type Guard = (next: Route) => boolean

let handler: Handler | null = null
let guard: Guard | null = null
let lastHash = window.location.hash || '#/'

export function setGuard(fn: Guard | null): void {
  guard = fn
}

export function hasGuard(): boolean {
  return guard !== null
}

function replaceHash(hash: string): void {
  // replaceState 不会触发 hashchange，用它静默回退被拦下的跳转。
  const url = `${window.location.pathname}${window.location.search}${hash}`
  window.history.replaceState(null, '', url)
}

export function navigate(route: Route, replace = false): void {
  const hash = routeHash(route)
  if (replace) {
    replaceHash(hash)
    lastHash = hash
    handler?.(route)
    return
  }
  if (hash === window.location.hash || (hash === '#/' && !window.location.hash)) {
    handler?.(route)
    return
  }
  window.location.hash = hash
}

export function currentRoute(): Route {
  return parseHash(window.location.hash)
}

function onHashChange(): void {
  const next = parseHash(window.location.hash)
  if (guard && !guard(next)) {
    replaceHash(lastHash)
    return
  }
  lastHash = window.location.hash || routeHash(next)
  handler?.(next)
}

export function startRouter(onRoute: Handler): void {
  handler = onRoute
  window.addEventListener('hashchange', onHashChange)
  if (!window.location.hash) {
    replaceHash('#/')
    lastHash = '#/'
  }
  handler(parseHash(window.location.hash))
}

/** 停掉路由监听（上锁后重新挂载应用时用，否则会叠多个监听）。 */
export function stopRouter(): void {
  window.removeEventListener('hashchange', onHashChange)
  handler = null
  guard = null
}
