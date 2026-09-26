// 文档视图：阅读模式（后端渲染的 html）/ 编辑模式（TipTap）
import { api } from '../api'
import { createEditor, type EditorHandle } from '../editor'
import type { DocResp } from '../types'
import { notebookName } from '../store'
import { clear, confirmDialog, errorBox, formatTime, h, spinner, toast } from '../dom'
import { navigate, setGuard } from '../router'

export interface ViewHandle {
  destroy: () => void
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

function decorate(html: string): string {
  return html?.trim() ? html : '<p class="muted">（空文档）</p>'
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
  const editing = params.mode === 'edit' && !readonly

  const header = h('div', { class: 'doc-header' })
  const actions = h('div', { class: 'doc-actions' })
  const titleRow = h(
    'div',
    { class: 'doc-title-row' },
    h('h1', { class: 'doc-title', title: doc.title }, doc.title || '(无标题)'),
    readonly ? h('span', { class: 'badge badge-muted', title: '文档标记为只读' }, '只读') : null,
    actions,
  )
  const meta = h(
    'div',
    { class: 'doc-meta' },
    h('span', { class: 'meta-item', title: '笔记本' }, `📚 ${notebookName(params.box)}`),
    h('span', { class: 'meta-item' }, `更新时间 ${formatTime(doc.updated) || '未知'}`),
    h('span', { class: 'meta-item muted', title: `box=${params.box} doc=${params.id}` }, `${(doc.blocks ?? []).length} 个块`),
  )
  header.appendChild(titleRow)
  header.appendChild(meta)
  const body = h('div', { class: 'doc-body' })
  root.appendChild(header)
  root.appendChild(body)

  if (params.mode === 'edit' && readonly) {
    toast('该文档为只读，已切换到阅读模式', 'info')
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      void save()
    }
  }
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (editor?.isDirty()) {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  async function save(): Promise<void> {
    if (!editor || editor.isSaving()) return
    editor.setSaving(true)
    try {
      const blocks = editor.getBlocks()
      await api.saveDoc(params.box, params.id, blocks)
      setGuard(null)
      window.removeEventListener('beforeunload', onBeforeUnload)
      toast('已保存', 'ok')
      await ctx.refreshTree()
      navigate({ name: 'doc', box: params.box, id: params.id, mode: 'read', block: '' }, true)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error', 5200)
    } finally {
      if (editor) editor.setSaving(false)
    }
  }

  function cancelEdit(): void {
    const go = (): void => {
      setGuard(null)
      window.removeEventListener('beforeunload', onBeforeUnload)
      navigate({ name: 'doc', box: params.box, id: params.id, mode: 'read', block: '' }, true)
    }
    if (editor?.isDirty()) {
      void confirmDialog('放弃未保存的修改？', '当前文档有未保存的改动，返回阅读模式将丢失这些改动。', '放弃修改').then(
        (ok) => {
          if (ok) go()
        },
      )
      return
    }
    go()
  }

  if (editing) {
    editor = createEditor({ blocks: doc.blocks ?? [] })
    body.classList.add('doc-body-plain')
    body.appendChild(editor.element)
    actions.appendChild(h('button', { class: 'btn', type: 'button', onclick: cancelEdit }, '取消'))
    actions.appendChild(
      h('button', { class: 'btn primary', type: 'button', title: '保存 (Ctrl+S)', onclick: () => void save() }, '保存'),
    )
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('beforeunload', onBeforeUnload)
    setGuard((next) => {
      if (!editor || !editor.isDirty()) return true
      const sameDoc = next.name === 'doc' && next.box === params.box && next.id === params.id
      if (sameDoc) return true
      void confirmDialog(
        '放弃未保存的修改？',
        '当前文档有未保存的改动，离开将丢失这些改动。',
        '放弃修改',
      ).then((ok) => {
        if (!ok) return
        setGuard(null)
        navigate(next)
      })
      return false
    })
  } else {
    body.innerHTML = `<article class="prose doc-html">${decorate(doc.html ?? '')}</article>`
    // 外链在应用内不该跳走：新标签页打开；图片加载失败给出可见提示
    body.addEventListener('click', (e) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href || href.startsWith('#')) return
      e.preventDefault()
      if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    })
    body.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.classList.add('img-broken')
        img.setAttribute('title', `图片加载失败：${img.getAttribute('src') ?? ''}`)
      })
    })
    if (!readonly) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            title: '进入编辑模式',
            onclick: () => navigate({ name: 'doc', box: params.box, id: params.id, mode: 'edit', block: params.block }),
          },
          '编辑',
        ),
      )
    }
    if (params.block) highlightBlock(body, params.block)
  }

  return {
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('beforeunload', onBeforeUnload)
      setGuard(null)
      editor?.destroy()
      editor = null
      root.remove()
    },
  }
}

/** 搜索结果定位：优先按思源的 data-node-id 命中，其次 data-id / id。 */
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
