// 极简全局状态：文档树、健康信息、当前选中项、树展开状态（localStorage 持久化）
import type { CurrentSelection, HealthResp, TreeResp } from './types'

const EXPAND_KEY = 'zt-note:expanded'

function loadExpanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPAND_KEY)
    if (!raw) return new Set<string>()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set<string>()
  }
}

export const store = {
  tree: null as TreeResp | null,
  treeError: '' as string,
  treeLoaded: false,
  health: null as HealthResp | null,
  healthError: '' as string,
  selection: null as CurrentSelection | null,
}

export const expanded = {
  set: loadExpanded(),
  has(key: string): boolean {
    return this.set.has(key)
  },
  toggle(key: string): void {
    if (this.set.has(key)) this.set.delete(key)
    else this.set.add(key)
    this.save()
  },
  add(key: string): void {
    if (this.set.has(key)) return
    this.set.add(key)
    this.save()
  },
  save(): void {
    try {
      window.localStorage.setItem(EXPAND_KEY, JSON.stringify([...this.set]))
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  },
}

/** 找到文档在树中的祖先链（用于自动展开）。 */
export function ancestorsOf(box: string, docId: string): string[] {
  const out: string[] = []
  const notebook = store.tree?.notebooks.find((nb) => nb.id === box)
  if (!notebook) return out
  const walk = (
    docs: typeof notebook.docs,
    trail: string[],
  ): boolean => {
    for (const doc of docs) {
      if (doc.id === docId) {
        out.push(...trail)
        return true
      }
      if (doc.children?.length && walk(doc.children, [...trail, doc.id])) return true
    }
    return false
  }
  walk(notebook.docs, [])
  return out
}

export function notebookName(box: string): string {
  const nb = store.tree?.notebooks.find((item) => item.id === box)
  return nb?.name || box
}

export function docTitle(box: string, docId: string): string {
  const nb = store.tree?.notebooks.find((item) => item.id === box)
  let found = ''
  const walk = (docs: NonNullable<typeof nb>['docs']): void => {
    for (const doc of docs) {
      if (doc.id === docId) {
        found = doc.title
        return
      }
      if (doc.children?.length) walk(doc.children)
    }
  }
  if (nb) walk(nb.docs)
  return found || docId
}
