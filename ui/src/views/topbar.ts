// 顶部工具条：新建 / 重命名 / 删除 / 导入 / 导出 / 搜索 / 版本
import { store } from '../store'
import { h, toast } from '../dom'
import type { CurrentSelection } from '../types'

export interface TopbarCtx {
  onNewNotebook: () => void
  onNewDoc: () => void
  onRename: () => void
  onDelete: () => void
  onImport: () => void
  onExport: (format: 'siyuan' | 'md', box: string) => void
  onSearch: (q: string) => void
  onGoHome: () => void
}

export interface TopbarHandle {
  element: HTMLElement
  /** 后端健康状态：有 error 时显示文案，否则显示版本号 */
  setHealth: (error: string) => void
  /** 依据当前选中项刷新按钮可用状态 */
  refresh: () => void
  /** 收起窄屏下的抽屉 / 动作面板（宽屏下是空操作） */
  closePanels: () => void
}

export function createTopbar(ctx: TopbarCtx): TopbarHandle {
  const btnNewNb = h('button', { class: 'btn', type: 'button', title: '新建笔记本' }, '新建笔记本')
  const btnNewDoc = h('button', { class: 'btn', type: 'button', title: '新建文档' }, '新建文档')
  const btnRename = h('button', { class: 'btn', type: 'button', title: '重命名文档' }, '重命名')
  const btnDelete = h('button', { class: 'btn danger', type: 'button', title: '删除文档' }, '删除')
  const btnImport = h('button', { class: 'btn', type: 'button', title: '导入 zip 或目录' }, '导入')

  btnNewNb.addEventListener('click', ctx.onNewNotebook)
  btnNewDoc.addEventListener('click', ctx.onNewDoc)
  btnRename.addEventListener('click', ctx.onRename)
  btnDelete.addEventListener('click', ctx.onDelete)
  btnImport.addEventListener('click', ctx.onImport)

  /* ---- 窄屏：抽屉（☰）与动作面板（⋯） ----
     两个按钮只在 ≤720px 处可见（宽屏由 CSS 藏起来），
     在这里也只是切 body 上的类，宽屏下没有副作用。 */
  const btnDrawer = h(
    'button',
    { class: 'btn topbar-burger', type: 'button', title: '文档树', 'aria-label': '文档树' },
    '☰',
  )
  const btnMore = h(
    'button',
    { class: 'btn topbar-more', type: 'button', title: '更多操作', 'aria-label': '更多操作' },
    '⋯',
  )

  function closePanels(): void {
    document.body.classList.remove('is-drawer-open', 'is-more-open')
  }

  function togglePanel(cls: 'is-drawer-open' | 'is-more-open'): void {
    const other = cls === 'is-drawer-open' ? 'is-more-open' : 'is-drawer-open'
    document.body.classList.remove(other)
    document.body.classList.toggle(cls)
  }

  btnDrawer.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePanel('is-drawer-open')
  })
  btnMore.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePanel('is-more-open')
  })
  // 窄屏下点了面板里的动作就把面板收起来
  for (const btn of [btnNewNb, btnNewDoc, btnRename, btnDelete, btnImport]) {
    btn.addEventListener('click', () => closePanels())
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanels()
  })

  /* ---- 导出下拉 ---- */
  const btnExport = h('button', { class: 'btn', type: 'button' }, '导出 ▾')
  const menu = h('div', { class: 'menu is-hidden' })
  const closeMenu = (): void => menu.classList.add('is-hidden')

  function buildMenu(): void {
    const sel = store.selection
    const items: Array<{ label: string; run: () => void; disabled?: boolean; sub?: string }> = []
    if (sel?.kind === 'doc' || sel?.kind === 'box') {
      const box = sel.box
      items.push({ label: '导出当前笔记本（思源 zip）', sub: 'data/<box>/<doc>.sy', run: () => ctx.onExport('siyuan', box) })
      items.push({ label: '导出当前笔记本（Markdown zip）', sub: '<笔记本>/<标题>.md', run: () => ctx.onExport('md', box) })
    } else {
      items.push({ label: '导出当前笔记本', sub: '先在左侧选中文档或笔记本', disabled: true, run: () => {} })
    }
    items.push({ label: '导出全部（思源 zip）', sub: '可直接解到思源工作区', run: () => ctx.onExport('siyuan', 'all') })
    items.push({ label: '导出全部（Markdown zip）', run: () => ctx.onExport('md', 'all') })

    menu.replaceChildren(
      ...items.map((item) =>
        h(
          'button',
          {
            class: `menu-item${item.disabled ? ' is-disabled' : ''}`,
            type: 'button',
            disabled: item.disabled ? 'true' : null,
            onclick: () => {
              if (item.disabled) return
              closeMenu()
              item.run()
            },
          },
          h('span', { class: 'menu-item-label' }, item.label),
          item.sub ? h('span', { class: 'menu-item-sub' }, item.sub) : null,
        ),
      ),
    )
  }

  btnExport.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.classList.contains('is-hidden')) {
      buildMenu()
      menu.classList.remove('is-hidden')
    } else {
      closeMenu()
    }
  })
  document.addEventListener('click', () => {
    closeMenu()
    closePanels()
  })

  const exportWrap = h('div', { class: 'menu-wrap' }, btnExport, menu)

  /* ---- 搜索 ---- */
  const searchInput = h('input', {
    class: 'input search-input',
    type: 'search',
    placeholder: '搜索笔记…（按 / 聚焦）',
    title: '按回车搜索，匹配标题与正文',
  }) as HTMLInputElement
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim()
      if (q) ctx.onSearch(q)
    } else if (e.key === 'Escape') {
      searchInput.value = ''
    }
  })
  window.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.defaultPrevented) return
    const el = document.activeElement
    const tag = el?.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || (el as HTMLElement | null)?.isContentEditable) return
    e.preventDefault()
    searchInput.focus()
    searchInput.select()
  })

  /* ---- 品牌 / 版本 ---- */
  const brand = h(
    'button',
    { class: 'brand', type: 'button', title: '回到首页' },
    h('span', { class: 'brand-mark' }, 'Zt'),
    h('span', { class: 'brand-name' }, 'zt-note'),
  )
  brand.addEventListener('click', ctx.onGoHome)

  const version = h('span', { class: 'version badge', title: '后端状态' }, '连接中…')

  const element = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'topbar-left' }, btnDrawer, brand),
    h(
      'div',
      { class: 'topbar-actions' },
      btnNewNb,
      btnNewDoc,
      h('span', { class: 'sep' }),
      btnRename,
      btnDelete,
      h('span', { class: 'sep' }),
      btnImport,
      exportWrap,
    ),
    h('div', { class: 'topbar-right' }, searchInput, version, btnMore),
  )

  function refresh(): void {
    const sel: CurrentSelection | null = store.selection
    const hasDoc = sel?.kind === 'doc'
    btnRename.disabled = !hasDoc
    btnDelete.disabled = !hasDoc
    btnNewDoc.disabled = !sel
    btnExport.disabled = store.treeLoaded === true && !(store.tree?.notebooks.length ?? 0)
    if (searchInput !== document.activeElement) {
      const routeQ = /[?&]q=([^&]*)/.exec(location.hash)
      if (routeQ) searchInput.value = decodeURIComponent(routeQ[1].replace(/\+/g, ' '))
    }
  }

  function setHealth(error: string): void {
    if (error) {
      const short = error.length > 26 ? `${error.slice(0, 26)}…` : error
      version.textContent = `后端错误：${short}`
      version.title = error
      version.classList.add('is-error')
      toast(`后端不可用：${error}`, 'error', 6000)
      return
    }
    const health = store.health
    version.classList.remove('is-error')
    version.textContent = health ? `v${health.version || '?'}` : '连接中…'
    version.title = health?.dataDir ? `后端版本 v${health.version}\n数据目录：${health.dataDir}` : '后端状态正常'
  }

  refresh()
  return { element, setHealth, refresh, closePanels }
}
