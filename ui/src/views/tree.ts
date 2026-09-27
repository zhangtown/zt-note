// 左侧文档树：笔记本 → 文档（children 递归）
import type { DocNode, Notebook } from '../types'
import { api } from '../api'
import { ancestorsOf, expanded, store } from '../store'
import { clear, emptyBox, errorBox, h, spinner } from '../dom'
import { attachLongPress, openMenu, openMenuAt, type MenuItem } from './menu'

export interface TreeHandle {
  element: HTMLElement
  reload: () => Promise<void>
  /** 按当前 store.selection 重绘（含自动展开祖先） */
  setSelection: () => void
}

interface TreeOptions {
  onSelectDoc: (box: string, id: string) => void
  onSelectBox: (box: string) => void
  /** 右键 / 长按 / ⋯ 菜单选中的动作，由 app.ts 执行（确认框 + 调接口 + 刷新） */
  onAction: (action: TreeAction) => void
}

/** 文档树上的菜单动作 */
export type TreeAction =
  | { kind: 'new-doc'; box: string; parentId?: string }
  | { kind: 'rename-doc'; box: string; id: string; title: string }
  | { kind: 'delete-doc'; box: string; id: string; title: string }
  | { kind: 'rename-box'; box: string; name: string }
  | { kind: 'delete-box'; box: string; name: string; count: number }

/** 已自动展开过的笔记本（避免把用户手动收起的又展开） */
const autoExpanded = new Set<string>()

/** 新建笔记时把笔记本记下来：新建成功后要展开它，否则新笔记看不见 */

export function rememberExpanded(box: string): void {
  autoExpanded.add(box)
  expanded.add(`box:${box}`)
}

function countDocs(docs: DocNode[]): number {
  let n = 0
  for (const doc of docs) {
    n += 1
    if (doc.children?.length) n += countDocs(doc.children)
  }
  return n
}

/** 挂在行上的「⋯」按钮 + 右键 + 长按，三种入口都开同一个菜单。 */
function attachMenu(
  row: HTMLElement,
  items: () => MenuItem[],
  opts: { more?: boolean } = {},
): HTMLElement {
  const open = (x: number, y: number) => {
    openMenu(x, y, items())
  }
  row.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    open(e.clientX, e.clientY)
  })
  attachLongPress(row, open)

  const more = h('button', {
    class: 'tree-more',
    type: 'button',
    title: '更多操作（右键也可以）',
    'aria-label': '更多操作',
    tabindex: -1,
  }, '⋯')
  more.addEventListener('click', (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(more, items())
  })
  if (opts.more === false) more.classList.add('is-hidden')
  return more
}

function docMenuItems(box: string, doc: DocNode, opts: TreeOptions): MenuItem[] {
  return [
    {
      label: '新建笔记',
      icon: '📝',
      onClick: () => opts.onAction({ kind: 'new-doc', box, parentId: doc.id }),
    },
    {
      label: '重命名',
      icon: '✏️',
      onClick: () => opts.onAction({ kind: 'rename-doc', box, id: doc.id, title: doc.title }),
    },
    {
      label: '删除',
      icon: '🗑️',
      danger: true,
      onClick: () => opts.onAction({ kind: 'delete-doc', box, id: doc.id, title: doc.title }),
    },
  ]
}

function boxMenuItems(nb: Notebook, opts: TreeOptions): MenuItem[] {
  return [
    { label: '新建笔记', icon: '📝', onClick: () => opts.onAction({ kind: 'new-doc', box: nb.id }) },
    { label: '重命名笔记本', icon: '✏️', onClick: () => opts.onAction({ kind: 'rename-box', box: nb.id, name: nb.name }) },
    {
      label: '删除笔记本',
      icon: '🗑️',
      danger: true,
      onClick: () =>
        opts.onAction({ kind: 'delete-box', box: nb.id, name: nb.name, count: countDocs(nb.docs) }),
    },
  ]
}

function docRow(
  box: string,
  doc: DocNode,
  depth: number,
  opts: TreeOptions,
  onRerender: () => void,
): HTMLElement {
  const key = `doc:${box}:${doc.id}`
  const children = doc.children ?? []
  const sel = store.selection
  const isActive = sel?.kind === 'doc' && sel.id === doc.id && sel.box === box
  const open = children.length > 0 && expanded.has(key)

  const caret = h(
    'span',
    {
      class: `tree-caret${children.length ? '' : ' is-empty'}`,
      title: children.length ? '展开/收起子文档' : '',
      onclick: (e: Event) => {
        e.stopPropagation()
        if (!children.length) return
        expanded.toggle(key)
        onRerender()
      },
    },
    children.length ? (open ? '▾' : '▸') : '',
  )

  const row = h(
    'div',
    {
      class: `tree-row tree-doc${isActive ? ' is-active' : ''}`,
      style: { paddingLeft: `${6 + depth * 14}px` },
      title: doc.title,
      onclick: () => {
        if (children.length) expanded.add(key)
        opts.onSelectDoc(box, doc.id)
      },
    },
    caret,
    h('span', { class: 'tree-icon' }, '📄'),
    h('span', { class: 'tree-label' }, doc.title || '(无标题)'),
  )
  row.appendChild(attachMenu(row, () => docMenuItems(box, doc, opts)))

  const wrap = h('div', { class: 'tree-doc-wrap' }, row)
  if (open) {
    for (const child of children) {
      wrap.appendChild(docRow(box, child, depth + 1, opts, onRerender))
    }
  }
  return wrap
}

function notebookBlock(nb: Notebook, opts: TreeOptions, onRerender: () => void): HTMLElement {
  const key = `box:${nb.id}`
  const open = expanded.has(key)
  const sel = store.selection
  const active = sel?.kind === 'box' && sel.box === nb.id
  const row = h(
    'div',
    {
      class: `tree-row tree-notebook${active ? ' is-active' : ''}`,
      title: `${nb.name}（点击选中：新建文档会放进该笔记本）`,
      onclick: () => {
        expanded.toggle(key)
        opts.onSelectBox(nb.id)
      },
    },
    h('span', { class: 'tree-caret' }, open ? '▾' : '▸'),
    h('span', { class: 'tree-icon' }, nb.icon || '📚'),
    h('span', { class: 'tree-label' }, nb.name || nb.id),
    h('span', { class: 'tree-count' }, String(countDocs(nb.docs))),
  )
  row.appendChild(attachMenu(row, () => boxMenuItems(nb, opts)))
  const wrap = h('div', { class: 'tree-notebook-wrap' }, row)
  if (open) {
    if (!nb.docs.length) {
      wrap.appendChild(h('div', { class: 'tree-empty-leaf' }, '（空笔记本）'))
    }
    for (const doc of nb.docs) wrap.appendChild(docRow(nb.id, doc, 1, opts, onRerender))
  }
  return wrap
}

export function createTreeView(opts: TreeOptions): TreeHandle {
  const element = h('div', { class: 'tree' })

  function render(): void {
    clear(element)
    if (!store.treeLoaded) {
      element.appendChild(spinner('加载文档树…'))
      return
    }
    if (store.treeError) {
      element.appendChild(
        errorBox(store.treeError, () => {
          void reload()
        }),
      )
      return
    }
    const notebooks = store.tree?.notebooks ?? []
    if (!notebooks.length) {
      element.appendChild(emptyBox('还没有笔记本', '用顶部「新建笔记本」创建，或点「导入」导入已有笔记。'))
      return
    }
    for (const nb of notebooks) {
      if (!autoExpanded.has(nb.id)) {
        autoExpanded.add(nb.id)
        expanded.add(`box:${nb.id}`)
      }
      element.appendChild(notebookBlock(nb, opts, render))
    }
    const active = element.querySelector('.tree-row.is-active')
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }

  async function reload(): Promise<void> {
    try {
      const data = await api.tree()
      store.tree = data
      store.treeError = ''
      store.treeLoaded = true
    } catch (err) {
      store.treeLoaded = true
      store.treeError = err instanceof Error ? err.message : '加载文档树失败'
    }
    render()
  }

  function setSelection(): void {
    const sel = store.selection
    if (sel?.kind === 'doc') {
      for (const key of ancestorsOf(sel.box, sel.id)) expanded.add(`doc:${sel.box}:${key}`)
      expanded.add(`box:${sel.box}`)
    }
    render()
  }

  render()
  return { element, reload, setSelection }
}
