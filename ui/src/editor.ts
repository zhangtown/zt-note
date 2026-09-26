// TipTap 编辑器：初始内容 = 各块 pm 顺序拼接；保存时按 LCS 对齐生成 blocks。
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import type { JSONContent } from '@tiptap/core'
import type { Block, SaveBlock } from './types'
import { apiUpload } from './api'
import { isDirty, planSave, sanitizeBlocks, stableStringify } from './docjson'
import { h, showModal, toast, type ModalButton } from './dom'

const LANGUAGE_SUGGESTIONS = [
  'go', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'rust', 'shell', 'bash', 'sql', 'json', 'yaml', 'html', 'css', 'xml',
  'markdown', 'diff', 'php', 'ruby', 'kotlin', 'swift', 'text',
]

/**
 * 图片节点：思源把图片的排版信息放在节点 Properties 里，
 * parent-style 决定“一行挤几张”（width: 25%），style 决定缩放尺寸。
 * 声明成额外属性后，改图片所在的块也不会把它们丢掉（保存时后端写回 .sy）。
 * 用 data-* 落地，避开与 HTML 原生 style 属性重名。
 */
const ImageWithLayout = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      parentStyle: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-parent-style'),
        renderHTML: (attrs) =>
          attrs.parentStyle ? { 'data-parent-style': attrs.parentStyle } : {},
      },
      style: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-style'),
        renderHTML: (attrs) => (attrs.style ? { 'data-style': attrs.style } : {}),
      },
    }
  },
})

export interface EditorHandle {
  /** 编辑器整体（含工具条） */
  element: HTMLElement
  isDirty: () => boolean
  getBlocks: () => SaveBlock[]
  isSaving: () => boolean
  setSaving: (value: boolean) => void
  destroy: () => void
}

interface ToolItem {
  id: string
  label: string
  title: string
  run: (editor: Editor) => void
  active?: (editor: Editor) => boolean
}

const TOOLS: Array<ToolItem | 'sep'> = [
  {
    id: 'bold',
    label: 'B',
    title: '粗体 (Ctrl+B)',
    run: (e) => e.chain().focus().toggleBold().run(),
    active: (e) => e.isActive('bold'),
  },
  {
    id: 'italic',
    label: 'I',
    title: '斜体 (Ctrl+I)',
    run: (e) => e.chain().focus().toggleItalic().run(),
    active: (e) => e.isActive('italic'),
  },
  {
    id: 'strike',
    label: 'S',
    title: '删除线',
    run: (e) => e.chain().focus().toggleStrike().run(),
    active: (e) => e.isActive('strike'),
  },
  {
    id: 'code',
    label: '</>',
    title: '行内代码',
    run: (e) => e.chain().focus().toggleCode().run(),
    active: (e) => e.isActive('code'),
  },
  'sep',
  {
    id: 'h1',
    label: 'H1',
    title: '一级标题',
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    active: (e) => e.isActive('heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: 'H2',
    title: '二级标题',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    active: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'H3',
    title: '三级标题',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    active: (e) => e.isActive('heading', { level: 3 }),
  },
  'sep',
  {
    id: 'bulletList',
    label: '• 列表',
    title: '无序列表',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    active: (e) => e.isActive('bulletList'),
  },
  {
    id: 'orderedList',
    label: '1. 列表',
    title: '有序列表',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    active: (e) => e.isActive('orderedList'),
  },
  {
    id: 'blockquote',
    label: '引用',
    title: '引用块',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    active: (e) => e.isActive('blockquote'),
  },
  {
    id: 'codeBlock',
    label: '代码块',
    title: '代码块',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    active: (e) => e.isActive('codeBlock'),
  },
  {
    id: 'horizontalRule',
    label: '分隔线',
    title: '水平线',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  'sep',
  {
    id: 'link',
    label: '链接',
    title: '插入/修改链接',
    run: (e) => {
      void editLink(e)
    },
    active: (e) => e.isActive('link'),
  },
  {
    id: 'image',
    label: '图片',
    title: '插入图片（URL 或上传到服务器）',
    run: (e) => {
      void insertImage(e)
    },
  },
  'sep',
  {
    id: 'undo',
    label: '↶',
    title: '撤销 (Ctrl+Z)',
    run: (e) => e.chain().focus().undo().run(),
  },
  {
    id: 'redo',
    label: '↷',
    title: '重做 (Ctrl+Shift+Z)',
    run: (e) => e.chain().focus().redo().run(),
  },
]

function safeHref(url: string): string | null {
  const value = url.trim()
  if (!value) return null
  if (/^\s*javascript:/i.test(value)) return null
  if (/^(https?:|mailto:|tel:|assets\/|\/|#)/i.test(value)) return value
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`
  return value
}

async function editLink(editor: Editor): Promise<void> {
  const current = (editor.getAttributes('link').href as string | undefined) ?? ''
  const input = h('input', { class: 'input', type: 'text', value: current, placeholder: 'https://example.com' })
  const body = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, '链接地址（留空表示取消链接）'),
    input,
  )
  const buttons: ModalButton[] = [{ label: '取消', value: '' }]
  if (current) buttons.push({ label: '取消链接', value: 'unlink' })
  buttons.push({ label: '确定', value: 'ok', primary: true })
  const res = await showModal({
    title: current ? '修改链接' : '插入链接',
    body,
    buttons,
    onSubmit: () => 'ok',
  })
  if (!res) return
  if (res === 'unlink') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  const href = safeHref(input.value)
  if (!href) {
    toast('链接地址无效', 'error')
    return
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
}

async function insertImage(editor: Editor): Promise<void> {
  const urlInput = h('input', { class: 'input', type: 'text', placeholder: 'assets/xxx.png 或 https://…' })
  const altInput = h('input', { class: 'input', type: 'text', placeholder: '（可选）' })
  const fileInput = h('input', { class: 'hidden-file', type: 'file', accept: 'image/*' })
  const status = h('div', { class: 'field-hint' }, '')
  const uploadBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      title: '上传图片到服务器 assets 目录',
      onclick: () => fileInput.click(),
    },
    '上传本地图片…',
  )
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    uploadBtn.disabled = true
    status.textContent = `上传中… ${file.name} 0%`
    uploadAsset(file, (percent) => {
      status.textContent = `上传中… ${file.name} ${percent}%`
    })
      .then((data) => {
        urlInput.value = data.url
        if (!altInput.value) altInput.value = file.name.replace(/\.[^.]+$/, '')
        status.textContent = `已上传：${data.url}（点「插入」放入正文）`
      })
      .catch((err: unknown) => {
        status.textContent = ''
        toast(err instanceof Error ? err.message : '上传失败', 'error')
      })
      .finally(() => {
        uploadBtn.disabled = false
        fileInput.value = ''
      })
  })
  const body = h(
    'div',
    { class: 'form' },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, '图片地址'),
      urlInput,
    ),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '替代文字 alt'), altInput),
    h('div', { class: 'field-inline' }, uploadBtn, fileInput, status),
    h(
      'div',
      { class: 'field-hint' },
      '相对地址（assets/xxx.png）指服务器 data/assets/；也可直接填外链。更快的办法：直接 Ctrl+V 粘贴截图，或把图片文件拖进正文。',
    ),
  )
  const res = await showModal({
    title: '插入图片',
    body,
    buttons: [
      { label: '取消', value: '' },
      { label: '插入', value: 'ok', primary: true },
    ],
    onSubmit: () => (urlInput.value.trim() ? 'ok' : null),
  })
  if (res !== 'ok') return
  const src = urlInput.value.trim()
  if (!src) return
  try {
    const ok = editor
      .chain()
      .focus()
      .setImage({ src, alt: altInput.value.trim() || '图片' })
      .run()
    if (!ok) toast('当前位置无法插入图片（例如代码块内）', 'error')
  } catch (err) {
    toast(err instanceof Error ? err.message : '插入图片失败', 'error')
  }
}

export function createEditor(opts: { blocks: Block[] }): EditorHandle {
  const toolbar = h('div', { class: 'zt-toolbar' })
  const editorHost = h('div', { class: 'zt-editor-body' })
  const foot = h('div', { class: 'zt-editor-foot' })
  const langInput = h('input', {
    class: 'tb-lang',
    type: 'text',
    list: 'zt-lang-list',
    placeholder: '语言',
    title: '代码块语言（如 go / python）',
  }) as HTMLInputElement
  langInput.disabled = true
  const langList = h(
    'datalist',
    { id: 'zt-lang-list' },
    ...LANGUAGE_SUGGESTIONS.map((lang) => h('option', { value: lang })),
  )

  const uploads = h('div', { class: 'zt-uploads' })
  const element = h(
    'div',
    { class: 'zt-editor' },
    toolbar,
    uploads,
    h('div', { class: 'zt-editor-scroll' }, editorHost),
    foot,
  )

  // 构造 Editor 时还不能拿到实例，但粘贴/拖拽回调一定是构造之后才触发的
  let editorRef: Editor | null = null

  const editor = new Editor({
    element: editorHost,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: { languageClassPrefix: 'language-', defaultLanguage: null },
        history: { depth: 500 },
        dropcursor: { color: '#7aa2f7', width: 2 },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      ImageWithLayout.configure({ inline: true, allowBase64: false, HTMLAttributes: { class: 'zt-image' } }),
      Placeholder.configure({ placeholder: '开始输入…' }),
    ],
    content: { type: 'doc', content: [] },
    editorProps: {
      attributes: { class: 'tiptap prose', spellcheck: 'false' },
      // 截图直接 Ctrl+V：拦截剪贴板里的图片文件，上传后插到光标处
      handlePaste: (view, event) => {
        const files = imageFilesFrom(event.clipboardData)
        if (!files.length || !editorRef) return false
        event.preventDefault()
        void uploadImagesAt(editorRef, view.state.selection.from, files, uploads)
        return true
      },
      // 拖入图片文件
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = imageFilesFrom(event.dataTransfer)
        if (!files.length || !editorRef) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void uploadImagesAt(editorRef, at ?? view.state.selection.from, files, uploads)
        return true
      },
    },
  })
  editorRef = editor

  // 用编辑器 schema 归一化后端给的 pm 节点，再灌进编辑器（避免未知节点导致崩溃）
  const sanitized = sanitizeBlocks(editor.schema, opts.blocks)
  editor
    .chain()
    .setContent({ type: 'doc', content: sanitized.content } as JSONContent, false)
    .setMeta('addToHistory', false)
    .run()

  const initialKey = stableStringify(editor.getJSON().content ?? [])
  let saving = false

  const buttons = new Map<string, HTMLButtonElement>()
  for (const item of TOOLS) {
    if (item === 'sep') {
      toolbar.appendChild(h('span', { class: 'tb-sep' }))
      continue
    }
    const btn = h(
      'button',
      {
        class: `tb-btn tb-${item.id}`,
        type: 'button',
        title: item.title,
        onclick: () => {
          item.run(editor)
          refresh()
        },
      },
      item.label,
    )
    buttons.set(item.id, btn)
    toolbar.appendChild(btn)
  }
  toolbar.appendChild(h('span', { class: 'tb-sep' }))
  toolbar.appendChild(
    h('span', { class: 'tb-lang-wrap', title: '选中代码块后可设置语言' }, langInput),
  )
  toolbar.appendChild(langList)

  let langTimer = 0
  const commitLang = () => {
    const value = langInput.value.trim()
    editor.chain().focus().updateAttributes('codeBlock', { language: value || null }).run()
  }
  langInput.addEventListener('input', () => {
    window.clearTimeout(langTimer)
    langTimer = window.setTimeout(commitLang, 250)
  })
  langInput.addEventListener('change', () => {
    window.clearTimeout(langTimer)
    commitLang()
  })

  const refresh = () => {
    for (const item of TOOLS) {
      if (item === 'sep') continue
      const btn = buttons.get(item.id)
      if (!btn) continue
      const on = item.active ? item.active(editor) : false
      btn.classList.toggle('is-active', on)
    }
    const inCode = editor.isActive('codeBlock')
    langInput.disabled = !inCode
    if (document.activeElement !== langInput) {
      const lang = (editor.getAttributes('codeBlock').language as string | null | undefined) ?? ''
      langInput.value = inCode ? lang : ''
    }
    const json = editor.getJSON()
    const blocks = json.content?.length ?? 0
    const text = editor.getText().replace(/\s/g, '').length
    foot.textContent = `${blocks} 个块 · ${text} 字`
    if (sanitized.unsupportedBlocks > 0) {
      foot.textContent += ` · 含 ${sanitized.unsupportedBlocks} 个编辑器不支持的块（未改动会原样保留）`
    }
  }
  editor.on('transaction', refresh)
  editor.on('selectionUpdate', refresh)
  refresh()

  return {
    element,
    isDirty: () => isDirty(editor.getJSON().content, initialKey),
    getBlocks: () => planSave(editor.getJSON().content ?? [], sanitized.baseline),
    isSaving: () => saving,
    setSaving: (value: boolean) => {
      saving = value
    },
    destroy: () => {
      window.clearTimeout(langTimer)
      editor.destroy()
      element.remove()
    },
  }
}

/** 从剪贴板 / 拖拽事件里挑出图片文件。 */
function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
}

/** 上传进度条（一行一条，粘多张图时依次排队）。 */
function uploadChip(
  host: HTMLElement,
  name: string,
): { progress: (percent: number) => void; done: (msg: string) => void; fail: (msg: string) => void } {
  const bar = h('i', {})
  const label = h('span', { class: 'zt-upload-name' }, name)
  const percent = h('span', { class: 'zt-upload-pct' }, '0%')
  const chip = h('div', { class: 'zt-upload' }, label, h('span', { class: 'zt-upload-bar' }, bar), percent)
  host.appendChild(chip)
  const clear = (ms: number) => window.setTimeout(() => chip.remove(), ms)
  return {
    progress: (p) => {
      const v = Math.max(0, Math.min(100, Math.round(p)))
      bar.style.width = `${v}%`
      percent.textContent = `${v}%`
    },
    done: (msg) => {
      chip.classList.add('is-done')
      label.textContent = `${name} · ${msg}`
      bar.style.width = '100%'
      percent.textContent = ''
      clear(1400)
    },
    fail: (msg) => {
      chip.classList.add('is-error')
      label.textContent = msg
      bar.style.width = '100%'
      percent.textContent = ''
      clear(6000)
      toast(msg, 'error')
    },
  }
}

/**
 * 上传并插入图片。上传是异步的，落点用触发那一刻的光标位置。
 * 插完一张把落点往后挪一个节点，多张图不会叠在一起。
 */
async function uploadImagesAt(
  editor: Editor,
  pos: number,
  files: File[],
  host: HTMLElement,
): Promise<void> {
  let at = pos
  for (const file of files) {
    const chip = uploadChip(host, file.name || '粘贴的图片')
    try {
      const res = await uploadAsset(file, (percent) => chip.progress(percent))
      const node = editor.schema.nodes.image.create({
        src: res.url,
        alt: file.name.replace(/\.[^.]+$/, '') || '图片',
      })
      const target = Math.max(0, Math.min(at, editor.state.doc.content.size))
      editor.chain().focus().insertContentAt(target, node).run()
      at = target + node.nodeSize
      chip.done('已插入')
    } catch (err) {
      chip.fail(err instanceof Error ? err.message : '上传失败')
    }
  }
}

/** 上传图片到服务器 data/assets/（POST api/assets/upload）。 */
export function uploadAsset(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ name: string; url: string }> {
  return apiUpload<{ name: string; url: string }>('api/assets/upload', file, 'file', onProgress)
}
