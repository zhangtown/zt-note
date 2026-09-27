// 文档视图：打开就能改（所见即所得），改动自动落盘、随时可撤销。
//
// 保存策略（三个常数见下）：
//   停笔 0.9s 后存一次；两次落盘至少隔 4s（打字时别每秒写盘）；
//   连续打字时最多拖 15s 也要落一次；切走/关页/离开路由前再补一存。
// 只读文档（后端标了 readonly）仍按后端渲染的 html 展示，不挂编辑器。
import { api, pinAssetTokens } from '../api'
import { createEditor, type EditorHandle } from '../editor'
import type { DocResp } from '../types'
import { notebookName } from '../store'
import { clear, confirmDialog, errorBox, formatTime, h, spinner, toast } from '../dom'
import { navigate, setGuard } from '../router'

export interface ViewHandle {
  destroy: () => void
  /** 可选：外部数据变了（如文档树重新加载）后让视图自己重新判断状态 */
  refresh?: () => void
}

export interface DocParams {
  box: string
  id: string
  mode: 'read' | 'edit'
  block: string
}

export interface DocCtx {
  refreshTree: () => Promise<void>
}

const noop: ViewHandle = { destroy: () => {} }

/** 停笔多久后落盘 */
const IDLE_MS = 900
/** 两次落盘的最小间隔（连续打字时不要每次停顿都写盘） */
const MIN_GAP_MS = 4000
/** 一直在打字时，最多拖这么久也强制落一存 */
const MAX_DELAY_MS = 15000

function decorate(html: string): string {
  return html?.trim() ? html : '<p class="muted">（空文档）</p>'
}

function clockText(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export async function mountDoc(
  main: HTMLElement,
  params: DocParams,
  ctx: DocCtx,
): Promise<ViewHandle> {
  let destroyed = false
  let editor: EditorHandle | null = null
  const root = h('div', { class: 'doc-view' })
  clear(main)
  main.appendChild(root)
  root.appendChild(spinner('加载文档…'))

  let doc: DocResp
  try {
    doc = await api.doc(params.box, params.id)
  } catch (err) {
    if (destroyed) return noop
    clear(root)
    root.appendChild(
      errorBox(err instanceof Error ? err.message : '加载文档失败', () => {
        void mountDoc(main, params, ctx)
      }),
    )
    return { destroy: () => { destroyed = true } }
  }
  if (destroyed) return noop
  clear(root)

  const readonly = Boolean(doc.readonly)
  /** 当前展示的是不是「后端渲染的只读 html」（只读文档 / 原样预览） */
  let renderedMode = readonly

  /** 把后端渲染的 html 铺到一个容器里（只读文档与「原样预览」共用） */
  function mountRendered(host: HTMLElement): void {
    clear(host)
    host.innerHTML = `<article class="prose doc-html">${decorate(doc.html ?? '')}</article>`
    // 图片子资源请求带不了请求头：把会话令牌挂到地址上（Cookie 靠不住时的兼底）
    pinAssetTokens(host)
    // 图片加载失败给出可见提示
    host.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.classList.add('img-broken')
        img.setAttribute('title', `图片加载失败：${img.getAttribute('src') ?? ''}`)
      })
    })
    if (params.block) highlightBlock(host, params.block)
  }

  // ---- 头部：标题（点一下就能改名）+ 元信息 + 保存状态 ----
  const state = h('span', { class: 'doc-state' }, '')
  const titleEl = h(
    'h1',
    { class: `doc-title${readonly ? '' : ' is-editable'}`, title: readonly ? '' : '点击可修改标题' },
    doc.title || '(无标题)',
  )
  const titleRow = h(
    'div',
    { class: 'doc-title-row' },
    titleEl,
    readonly ? h('span', { class: 'badge badge-muted', title: '文档标记为只读' }, '只读') : null,
  )
  const meta = h(
    'div',
    { class: 'doc-meta' },
    h('span', { class: 'meta-item', title: '笔记本' }, `📚 ${notebookName(params.box)}`),
    h('span', { class: 'meta-item' }, `更新时间 ${formatTime(doc.updated) || '未知'}`),
    h('span', { class: 'meta-item muted', title: `box=${params.box} doc=${params.id}` }, `${(doc.blocks ?? []).length} 个块`),
    state,
  )
  const header = h('div', { class: 'doc-header' }, titleRow, meta)
  const body = h('div', { class: 'doc-body' })
  // 外链在应用内不该跳走：新标签页打开（只在只读 / 预览视图里生效：编辑时点链接就是要改文字）
  body.addEventListener('click', (e) => {
    if (!renderedMode) return
    const anchor = (e.target as HTMLElement | null)?.closest?.('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) return
    e.preventDefault()
    if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  })
  root.appendChild(header)
  root.appendChild(body)

  /** 点标题改名：回车/失焦保存，Esc 放弃 */
  function enableTitleEdit(): void {
    titleEl.addEventListener('click', () => {
      const input = h('input', {
        class: 'doc-title-input',
        type: 'text',
        value: doc.title,
        spellcheck: 'false',
        'aria-label': '文档标题',
      }) as HTMLInputElement
      titleEl.replaceWith(input)
      input.focus()
      input.select()
      let done = false
      const finish = async (commit: boolean): Promise<void> => {
        if (done) return
        done = true
        const next = input.value.trim()
        input.replaceWith(titleEl)
        if (!commit || !next || next === doc.title) return
        try {
          await api.renameDoc(params.box, params.id, next)
          doc.title = next
          titleEl.textContent = next
          document.title = `${next} · 云栖笔记`
          toast('标题已修改', 'ok')
          await ctx.refreshTree()
        } catch (err) {
          toast(err instanceof Error ? err.message : '改标题失败', 'error')
        }
      }
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          void finish(false)
        }
      })
      input.addEventListener('blur', () => void finish(true))
    })
  }

  // ---- 只读文档：后端渲染的 html，不挂编辑器 ----
  if (readonly) {
    if (params.mode === 'edit') toast('该文档为只读，已按阅读模式打开', 'info')
    mountRendered(body)
    return {
      destroy: () => {
        if (destroyed) return
        destroyed = true
        root.remove()
      },
    }
  }

  // ---- 可编辑：直接挂编辑器，不再有「编辑 / 保存」按钮 ----
  let idleTimer = 0
  let dirtySince = 0
  let lastSaveAt = 0
  let failed = ''
  let inflight: Promise<boolean> | null = null
  let leaving = false

  const setState = (text: string, cls = ''): void => {
    state.textContent = text
    state.className = `doc-state${cls ? ` ${cls}` : ''}`
  }

  /** 存一次。返回是否成功（没改动也算成功）。 */
  async function flush(keepalive = false): Promise<boolean> {
    const ed = editor
    if (!ed) return true
    if (inflight) await inflight
    if (!ed.isDirty()) {
      // 内容已经和上次保存的一致（例如撤销后又重做回来）——把状态文案摆正，避免一直显示「有未保存的改动」
      dirtySince = 0
      failed = ''
      setState(`已保存 ${clockText()}`, 'is-saved')
      return true
    }
    let ok = true
    let err = ''
    ed.setSaving(true)
    setState('保存中…', 'is-saving')
    // 先取快照再发请求：请求在途时用户继续打字时，那些字不在 sent 里，
    // 绝不能当成「已保存」（否则定时器下一次 flush 会直接跳过，输入就丢了）
    const sent = ed.getBlocks()
    inflight = (async () => {
      try {
        const res = await api.saveDoc(params.box, params.id, sent, keepalive)
        ed.markSaved(sent, res?.blocks)
        failed = ''
        return true
      } catch (e) {
        ok = false
        err = e instanceof Error ? e.message : '保存失败'
        failed = err
        return false
      }
    })()
    await inflight
    inflight = null
    ed.setSaving(false)
    lastSaveAt = Date.now()
    if (!ok) {
      setState(`保存失败：${err}（改动还在，会自动重试）`, 'is-error')
      toast(`保存失败：${err}`, 'error', 5200)
      return false
    }
    if (ed.isDirty()) return flush() // 存盘期间又改了 → 再存一轮
    dirtySince = 0
    setState(`已保存 ${clockText()}`, 'is-saved')
    return true
  }

  function scheduleSave(): void {
    if (destroyed || !editor) return
    dirtySince ||= Date.now()
    if (failed) setState(`有未保存的改动（上次失败：${failed}）`, 'is-error')
    else setState('有未保存的改动…', 'is-dirty')
    window.clearTimeout(idleTimer)
    if (Date.now() - dirtySince >= MAX_DELAY_MS) {
      void flush()
      return
    }
    const gap = MIN_GAP_MS - (Date.now() - lastSaveAt)
    idleTimer = window.setTimeout(() => void flush(), Math.max(IDLE_MS, gap))
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      window.clearTimeout(idleTimer)
      void flush()
    }
  }
  // 页面被藏起来 / 关掉：补一存（keepalive 让请求活过卸载）
  const onPageHide = (): void => {
    window.clearTimeout(idleTimer)
    if (editor?.isDirty()) void flush(true)
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') onPageHide()
  }
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!failed && !editor?.isDirty()) return
    e.preventDefault()
    e.returnValue = ''
  }

  editor = createEditor({ blocks: doc.blocks ?? [], onChange: scheduleSave })
  body.classList.add('doc-body-plain')
  body.appendChild(editor.element)
  // 刚打开、还没动过：状态栏就应明确显示「已保存」，而不是空白（否则用户不知道到底存没存）
  setState('已保存', 'is-saved')
  enableTitleEdit()

  // 有些块（如思源的图片行布局）编辑器看不懂：给一个「原样预览」开关，随时看后端渲染的原貌
  const unsupported = editor.unsupported()
  const btnPreview = h(
    'button',
    {
      class: `link-btn doc-preview-btn${unsupported > 0 ? ' is-warn' : ''}`,
      type: 'button',
      title:
        unsupported > 0
          ? `有 ${unsupported} 个块编辑器不能完整呈现：点这里看后端渲染的原貌（只读）`
          : '看后端渲染的原貌（只读）',
    },
    '原样预览',
  )
  titleRow.appendChild(h('span', { class: 'doc-title-actions' }, btnPreview))
  let inPreview = false
  async function showPreview(): Promise<void> {
    if (!editor) return
    if (editor.isDirty()) {
      window.clearTimeout(idleTimer)
      const ok = await flush()
      if (!ok) {
        const go = await confirmDialog(
          '保存失败，仍要看预览？',
          `最新改动还没保存到服务器：${failed || '未知错误'}。现在看到的是修改前的内容。`,
          '继续预览',
        )
        if (!go) return
      }
    }
    // 原样预览用的是后端渲染的 html：必须重新拉一份，否则看到的是打开这篇笔记那一刻的旧版本
    let fresh: DocResp
    try {
      fresh = await api.doc(params.box, params.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : '取原样预览失败', 'error')
      return
    }
    doc.html = fresh.html ?? ''
    inPreview = true
    renderedMode = true
    body.classList.remove('doc-body-plain')
    mountRendered(body)
    editor.element.remove()
    btnPreview.textContent = '回到编辑'
    btnPreview.title = '回到可编辑的所见即所得视图'
    setState(unsupported > 0 ? `原样预览（${unsupported} 个块编辑器不支持）` : '原样预览', '')
  }
  function showEdit(): void {
    inPreview = false
    renderedMode = false
    body.classList.add('doc-body-plain')
    clear(body)
    if (editor) body.appendChild(editor.element)
    btnPreview.textContent = '原样预览'
    btnPreview.title =
      unsupported > 0
        ? `有 ${unsupported} 个块编辑器不能完整呈现：点这里看后端渲染的原貌（只读）`
        : '看后端渲染的原貌（只读）'
    if (editor && !editor.isDirty()) setState(`已保存 ${clockText()}`, 'is-saved')
    else setState('有未保存的改动…', 'is-dirty')
  }
  btnPreview.addEventListener('click', () => {
    if (inPreview) showEdit()
    else void showPreview()
  })
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('beforeunload', onBeforeUnload)

  // 离开这篇文档前先把改动落盘；失败就再问一句，别默默丢
  setGuard((next) => {
    if (leaving || !editor) return true
    if (!editor.isDirty() && !inflight) return true
    leaving = true
    window.clearTimeout(idleTimer)
    void flush().then((ok) => {
      if (ok) {
        setGuard(null)
        navigate(next)
        return
      }
      leaving = false
      void confirmDialog(
        '保存失败，仍要离开？',
        `这篇笔记的最新改动没能保存到服务器：${failed || '未知错误'}。现在离开会丢掉这些改动。`,
        '仍然离开',
      ).then((yes) => {
        if (!yes) return
        setGuard(null)
        navigate(next)
      })
    })
    return false
  })

  if (params.block) {
    const okReveal = editor.revealBlock(params.block)
    if (!okReveal) {
      toast('没找到搜索结果所在的块（可能已被删除）', 'info')
    }
  }

  return {
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.clearTimeout(idleTimer)
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onBeforeUnload)
      setGuard(null)
      // 视口外/直接销毁时兜一存（正常路径已由 setGuard 存过，这里重复也没事：内容没变不会再写）
      if (editor?.isDirty()) void flush(true)
      editor?.destroy()
      editor = null
      root.remove()
    },
  }
}

/** 搜索结果定位（只读渲染用）：优先按思源的 data-node-id 命中，其次 data-id / id。 */
function highlightBlock(body: HTMLElement, blockId: string): void {
  const safe = blockId.replace(/["\\]/g, '\\$&')
  const target =
    body.querySelector(`[data-node-id="${safe}"]`) ??
    body.querySelector(`[data-id="${safe}"]`) ??
    body.querySelector(`[id="${safe}"]`)
  if (!target) return
  target.classList.add('block-flash')
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center' })
  }
}
