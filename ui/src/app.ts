// 应用装配：会话（PIN 门）→ 布局（顶部工具条 + 左侧文档树 + 主区域）、路由分发、全局动作
import { api, clearToken, exportUrl, setGateBusy, setUnauthorizedHandler, triggerDownload } from './api'
import { confirmDialog, h, promptDialog, toast } from './dom'
import {
  currentRoute,
  navigate,
  parseHash,
  selectionOf,
  startRouter,
  stopRouter,
  type Route,
} from './router'
import { store, docTitle, expanded } from './store'
import { createAutoLock, readAutoLockMinutes } from './autolock'
import { openSecurityDialog } from './views/security'
import { createTreeView, rememberExpanded, type TreeAction, type TreeHandle } from './views/tree'
import { createTopbar, type TopbarHandle } from './views/topbar'
import { logoMark } from './logo'
import { mountDoc, type ViewHandle } from './views/doc'
import { createGate } from './views/gate'
import { mountHome } from './views/home'
import { mountImport } from './views/import'
import { mountSearch } from './views/search'
import type { SessionResp } from './types'

/** 当前挂载的主界面拆除函数（上锁 / 换身份时用） */
let teardown: (() => void) | null = null
/** 现在是不是停在 PIN 屏（避免 401 风暴里反复重建） */
let gated = false

/* ---------------- 启动：先问会话，再决定显示 PIN 屏还是主界面 ---------------- */

export function bootstrap(): void {
  const app = document.getElementById('app')
  if (!app) throw new Error('缺少 #app 挂载点')
  setUnauthorizedHandler(() => {
    // 会话没了（锁定 / 后端重启）：回到 PIN 屏
    if (gated) return
    gated = true
    setGateBusy(true)
    void openSession(app)
  })
  void openSession(app)
}

async function openSession(app: HTMLElement): Promise<void> {
  teardown?.()
  teardown = null
  try {
    const session = await api.session()
    if (session.needsSetup || session.locked) {
      gated = true
      setGateBusy(true)
      // 页面带的是别的账号的旧凭证：清掉，省得每次请求都白带一枚废令牌
      if (session.reason === 'identity_changed') clearToken()
      app.replaceChildren(
        createGate({
          session,
          onUnlocked: () => {
            gated = false
            setGateBusy(false)
            void openSession(app)
          },
        }),
      )
      return
    }
    gated = false
    setGateBusy(false)
    teardown = mountApp(app, session)
  } catch (err) {
    gated = true
    setGateBusy(true)
    app.replaceChildren(bootError(err, () => void openSession(app)))
  }
}

/** 后端连不上时的启动错误屏 */
function bootError(err: unknown, retry: () => void): HTMLElement {
  const message = err instanceof Error ? err.message : String(err)
  return h(
    'div',
    { class: 'gate' },
    h(
      'div',
      { class: 'gate-card' },
      h(
        'div',
        { class: 'gate-brand' },
        logoMark(28),
        h(
          'div',
          {},
          h('div', { class: 'gate-title' }, '云栖笔记'),
          h('div', { class: 'gate-sub' }, '飞牛 NAS · 思源笔记格式'),
        ),
      ),
      h('div', { class: 'gate-msg is-error' }, `连不上后端：${message}`),
      h(
        'div',
        { class: 'gate-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: retry }, '重试'),
      ),
    ),
  )
}

/* ---------------- 主界面 ---------------- */

function mountApp(app: HTMLElement, session: SessionResp): () => void {

  const main = h('main', { class: 'main', id: 'main' })
  let current: ViewHandle | null = null
  let renderedHash = ''
  let renderSeq = 0
  let tree: TreeHandle
  let topbar: TopbarHandle

  const refreshTree = async (): Promise<void> => {
    await tree?.reload()
    topbar?.refresh()
    // 树变了，首页的空态横幅之类要重新判断（否则"还没有笔记本"会挂在已经导入好的笔记本上）
    current?.refresh?.()
  }

  /* ---- 闲置自动锁定：多久没动就回 PIN 屏（时长按设备存在 localStorage） ---- */
  const autoLock = createAutoLock({
    minutes: readAutoLockMinutes,
    onLock: () => void lockNow('idle'),
  })

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

  async function actionNewDoc(boxArg?: string, parentId?: string): Promise<void> {
    const sel = store.selection
    const box = boxArg || currentBox()
    if (!box) {
      toast('请先在左侧选择一个笔记本（或先新建笔记本）', 'error')
      return
    }
    const parent = parentId ?? (sel?.kind === 'doc' && sel.box === box ? sel.id : undefined)
    const parentTitle = parent
      ? store.tree?.notebooks
          .find((nb) => nb.id === box)
          ?.docs.find((d) => d.id === parent)?.title ?? parent
      : ''
    const title = await promptDialog(
      '新建文档',
      '文档标题',
      '',
      '例如：会议记录',
    )
    if (title === null) return
    try {
      const res = await api.createDoc(box, title || '未命名文档', parent)
      if (parent) expanded.add(`doc:${box}:${parent}`)
      rememberExpanded(box)
      toast(parent ? `已在「${parentTitle}」下新建子文档` : '已创建文档', 'ok')
      await refreshTree()
      if (res?.id) navigate({ name: 'doc', box, id: res.id, mode: 'read', block: '' })
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建文档失败', 'error')
    }
  }

  /** target 为空时用左侧当前选中项（顶栏按钮走这条路）。 */
  async function actionRename(target?: { box: string; id: string; title: string }): Promise<void> {
    const sel = target ?? (store.selection?.kind === 'doc'
      ? {
          box: store.selection.box,
          id: store.selection.id,
          title: docTitle(store.selection.box, store.selection.id),
        }
      : null)
    if (!sel) {
      toast('请先在左侧选择要重命名的文档', 'error')
      return
    }
    const title = await promptDialog('重命名文档', '新标题', sel.title, '')
    if (!title) return
    try {
      await api.renameDoc(sel.box, sel.id, title)
      toast('已重命名', 'ok')
      await refreshTree()
      const route = currentRoute()
      if (route.name === 'doc' && route.box === sel.box && route.id === sel.id) {
        await render(route, true)
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  /** target 为空时用左侧当前选中项（顶栏按钮走这条路）。 */
  async function actionDelete(target?: { box: string; id: string; title: string }): Promise<void> {
    const sel = target ?? (store.selection?.kind === 'doc'
      ? {
          box: store.selection.box,
          id: store.selection.id,
          title: docTitle(store.selection.box, store.selection.id),
        }
      : null)
    if (!sel) {
      toast('请先在左侧选择要删除的文档', 'error')
      return
    }
    const ok = await confirmDialog(
      '删除文档',
      `确定删除「${sel.title}」？子文档会一并删除，此操作不可撤销。`,
      '删除',
      true,
    )
    if (!ok) return
    try {
      await api.deleteDoc(sel.box, sel.id)
      toast('已删除', 'ok')
      if (store.selection?.kind === 'doc' && store.selection.id === sel.id) store.selection = null
      await refreshTree()
      const route = currentRoute()
      if (route.name === 'doc' && route.box === sel.box && route.id === sel.id) {
        navigate({ name: 'home' })
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  async function actionRenameNotebook(box: string, name: string): Promise<void> {
    const next = await promptDialog('重命名笔记本', '笔记本名称', name, '')
    if (!next || next === name) return
    try {
      await api.renameNotebook(box, next)
      toast('已重命名笔记本', 'ok')
      await refreshTree()
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名笔记本失败', 'error')
    }
  }

  async function actionDeleteNotebook(box: string, name: string, count: number): Promise<void> {
    const detail = count > 0 ? `其中的 ${count} 篇笔记` : '它（目前是空的）'
    const ok = await confirmDialog(
      '删除笔记本',
      `确定删除「${name}」？${detail}会一并删掉，此操作不可撤销。`,
      '删除',
      true,
    )
    if (!ok) return
    try {
      await api.deleteNotebook(box)
      toast(`已删除笔记本「${name}」`, 'ok')
      if (store.selection?.box === box) store.selection = null
      await refreshTree()
      const route = currentRoute()
      if (route.name === 'doc' && route.box === box) navigate({ name: 'home' })
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除笔记本失败', 'error')
    }
  }

  /** 文档树上的右键 / 长按 / ⋯ 菜单（动作类型见 views/tree.ts 的 TreeAction） */
  function treeAction(action: TreeAction): void {
    switch (action.kind) {
      case 'new-doc':
        void actionNewDoc(action.box, action.parentId)
        break
      case 'rename-doc':
        void actionRename({ box: action.box, id: action.id, title: action.title })
        break
      case 'delete-doc':
        void actionDelete({ box: action.box, id: action.id, title: action.title })
        break
      case 'rename-box':
        void actionRenameNotebook(action.box, action.name)
        break
      case 'delete-box':
        void actionDeleteNotebook(action.box, action.name, action.count)
        break
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
    // 路线一变（点文档、回首页、搜到结果…）就把窄屏的抽屉/面板收起来
    topbar?.closePanels()
    homeNav.classList.toggle('is-active', route.name === 'home')
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
      topbar?.closePanels()
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
    onAction: treeAction,
  })

  topbar = createTopbar({
    onNewNotebook: () => void actionNewNotebook(),
    onNewDoc: () => void actionNewDoc(),
    onRename: () => void actionRename(),
    onDelete: () => void actionDelete(),
    onImport: () => navigate({ name: 'import' }),
    onExport: actionExport,
    onSearch: (q) => navigate({ name: 'search', q }),
    session,
    onLock: () => void lockNow(),
    onSecurity: () =>
      void openSecurityDialog({
        session,
        onLock: () => void lockNow(),
        onAutoLockChange: () => autoLock.touch(),
      }),
  })

  /** reason=idle 是闲置自动锁定（给一句提示，免得用户以为被踢了） */
  async function lockNow(reason: 'user' | 'idle' = 'user'): Promise<void> {
    autoLock.stop()
    if (reason === 'idle') toast('闲置太久，已自动上锁', 'info', 4000)
    try {
      await api.pinLock()
    } catch {
      /* 已经失效也无所谓，下面照样回 PIN 屏 */
    }
    // 上锁会把本机的令牌一起作废，本地那份也清掉，免得带着废令牌再请求
    clearToken()
    store.selection = null
    await openSession(app)
  }

  /* 侧栏顶部不放品牌（首页 hero 已经有「云栖笔记」标识，重复），
     只放一个「首页」导航项：顶栏没有品牌之后，它是唯一的回首页入口，
     窄屏时就在抽屉最上方，点得到。 */
  const homeNav = h(
    'button',
    { class: 'tree-nav-item', type: 'button', title: '回到首页' },
    h('span', { class: 'tree-nav-icon' }, '🏠'),
    h('span', { class: 'tree-nav-label' }, '首页'),
  )
  homeNav.addEventListener('click', () => {
    topbar.closePanels()
    navigate({ name: 'home' })
  })

  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      topbar.element,
      h(
        'div',
        { class: 'shell-body' },
        h('aside', { class: 'sidebar' }, h('div', { class: 'tree-nav' }, homeNav), tree.element),
        main,
      ),
      // 窄屏抽屉/动作面板打开时的遮罩，点一下收起（宽屏下被 CSS 藏起来）
      h('div', {
        class: 'drawer-mask',
        'aria-hidden': 'true',
        onclick: () => topbar.closePanels(),
      }),
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
  autoLock.start()
  void loadHealth()
  void refreshTree()

  startRouter((route) => {
    void render(route)
  })
  // startRouter 会同步触发一次渲染；若实现改为异步监听，这里补一次
  void render(parseHash(location.hash))

  return () => {
    autoLock.stop()
    stopRouter()
    current?.destroy()
    current = null
    store.selection = null
    store.tree = null
    store.treeLoaded = false
    store.treeError = ''
  }
}
