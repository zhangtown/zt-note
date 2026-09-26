// 应用装配：布局（顶部工具条 + 左侧文档树 + 主区域）、路由分发、全局动作
import { api, exportUrl, triggerDownload } from './api'
import { confirmDialog, h, promptDialog, toast } from './dom'
import { currentRoute, navigate, parseHash, selectionOf, startRouter, type Route } from './router'
import { store, docTitle } from './store'
import { createTreeView, type TreeHandle } from './views/tree'
import { createTopbar, type TopbarHandle } from './views/topbar'
import { mountDoc, type ViewHandle } from './views/doc'
import { mountHome } from './views/home'
import { mountImport } from './views/import'
import { mountSearch } from './views/search'

export function bootstrap(): void {
  const app = document.getElementById('app')
  if (!app) throw new Error('缺少 #app 挂载点')

  const main = h('main', { class: 'main', id: 'main' })
  let current: ViewHandle | null = null
  let renderedHash = ''
  let renderSeq = 0
  let tree: TreeHandle
  let topbar: TopbarHandle

  const refreshTree = async (): Promise<void> => {
    await tree?.reload()
    topbar?.refresh()
  }

  /* ---------------- 全局动作 ---------------- */

  const currentBox = (): string => {
    const sel = store.selection
    if (sel) return sel.box
    const notebooks = store.tree?.notebooks ?? []
    return notebooks.length === 1 ? notebooks[0].id : ''
  }

  async function actionNewNotebook(): Promise<void> {
    const name = await promptDialog('新建笔记本', '笔记本名称', '', '例如：工作笔记')
    if (!name) return
    try {
      await api.createNotebook(name)
      toast(`已创建笔记本「${name}」`, 'ok')
      await refreshTree()
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建笔记本失败', 'error')
    }
  }

  async function actionNewDoc(): Promise<void> {
    const sel = store.selection
    const box = currentBox()
    if (!box) {
      toast('请先在左侧选择一个笔记本（或先新建笔记本）', 'error')
      return
    }
    const parentId = sel?.kind === 'doc' ? sel.id : undefined
    const parentTitle = parentId
      ? store.tree?.notebooks
          .find((nb) => nb.id === box)
          ?.docs.find((d) => d.id === parentId)?.title ?? parentId
      : ''
    const title = await promptDialog(
      '新建文档',
      '文档标题',
      '',
      '例如：会议记录',
    )
    if (title === null) return
    try {
      const res = await api.createDoc(box, title || '未命名文档', parentId)
      toast(parentId ? `已在「${parentTitle}」下新建子文档` : '已创建文档', 'ok')
      await refreshTree()
      if (res?.id) navigate({ name: 'doc', box, id: res.id, mode: 'read', block: '' })
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建文档失败', 'error')
    }
  }

  async function actionRename(): Promise<void> {
    const sel = store.selection
    if (sel?.kind !== 'doc') {
      toast('请先在左侧选择要重命名的文档', 'error')
      return
    }
    const title = await promptDialog('重命名文档', '新标题', docTitle(sel.box, sel.id), '')
    if (!title) return
    try {
      await api.renameDoc(sel.box, sel.id, title)
      toast('已重命名', 'ok')
      await refreshTree()
      if (currentRoute().name === 'doc') await render(currentRoute(), true)
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  async function actionDelete(): Promise<void> {
    const sel = store.selection
    if (sel?.kind !== 'doc') {
      toast('请先在左侧选择要删除的文档', 'error')
      return
    }
    const ok = await confirmDialog(
      '删除文档',
      `确定删除「${docTitle(sel.box, sel.id)}」？子文档会一并删除，此操作不可撤销。`,
      '删除',
    )
    if (!ok) return
    try {
      await api.deleteDoc(sel.box, sel.id)
      toast('已删除', 'ok')
      store.selection = null
      await refreshTree()
      const route = currentRoute()
      if (route.name === 'doc' && route.id === sel.id) navigate({ name: 'home' })
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  function actionExport(format: 'siyuan' | 'md', box: string): void {
    try {
      triggerDownload(exportUrl(format, box))
      toast(box === 'all' ? '正在导出全部笔记本…' : '正在导出当前笔记本…', 'info')
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败', 'error')
    }
  }

  /* ---------------- 视图分发 ---------------- */

  async function render(route: Route, force = false): Promise<void> {
    const key = location.hash || '#/'
    if (!force && key === renderedHash && current) return
    renderedHash = key
    const seq = ++renderSeq
    current?.destroy()
    current = null

    if (route.name === 'doc') {
      store.selection = { kind: 'doc', box: route.box, id: route.id }
      tree?.setSelection()
      topbar?.refresh()
      const handle = await mountDoc(
        main,
        { box: route.box, id: route.id, mode: route.mode, block: route.block },
        { refreshTree },
      )
      if (seq !== renderSeq) {
        // 加载期间又跳走了，丢弃这一份
        handle.destroy()
        return
      }
      current = handle
      tree?.setSelection()
      return
    }

    topbar?.refresh()
    if (route.name === 'search') {
      current = mountSearch(main, route.q)
    } else if (route.name === 'import') {
      current = mountImport(main, { refreshTree })
    } else {
      current = mountHome(main, {
        newNotebook: () => void actionNewNotebook(),
        newDoc: () => void actionNewDoc(),
        goImport: () => navigate({ name: 'import' }),
      })
    }
    tree?.setSelection()
  }

  /* ---------------- 组装 ---------------- */

  tree = createTreeView({
    onSelectDoc: (box, id) => {
      const sel = store.selection
      if (sel?.kind === 'doc' && sel.box === box && sel.id === id) {
        tree.setSelection()
        return
      }
      navigate({ name: 'doc', box, id, mode: 'read', block: '' })
    },
    onSelectBox: (box) => {
      store.selection = { kind: 'box', box }
      tree.setSelection()
      topbar.refresh()
    },
  })

  topbar = createTopbar({
    onNewNotebook: () => void actionNewNotebook(),
    onNewDoc: () => void actionNewDoc(),
    onRename: () => void actionRename(),
    onDelete: () => void actionDelete(),
    onImport: () => navigate({ name: 'import' }),
    onExport: actionExport,
    onSearch: (q) => navigate({ name: 'search', q }),
    onGoHome: () => navigate({ name: 'home' }),
  })

  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      topbar.element,
      h('div', { class: 'shell-body' }, h('aside', { class: 'sidebar' }, tree.element), main),
    ),
  )

  /* 点击版本号重试健康检查 */
  topbar.element.querySelector('.version')?.addEventListener('click', () => void loadHealth())

  async function loadHealth(): Promise<void> {
    try {
      const health = await api.health()
      store.health = { ...health, ok: true }
      store.healthError = ''
      topbar.setHealth('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '无法连接后端'
      store.healthError = msg
      topbar.setHealth(msg)
    }
  }

  store.selection = selectionOf(parseHash(location.hash))
  topbar.refresh()
  void loadHealth()
  void refreshTree()

  startRouter((route) => {
    void render(route)
  })
  // startRouter 会同步触发一次渲染；若实现改为异步监听，这里补一次
  void render(parseHash(location.hash))
}
