// TipTap 编辑器：初始内容 = 各块 pm 顺序拼接；保存时按 LCS 对齐生成 blocks。
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { JSONContent } from '@tiptap/core'
import { ImageWithLayout } from './image-ext'
import { tableExtensions } from './table-ext'
import type { Block, SaveBlock } from './types'
import { pinAssetTokens, apiUpload } from './api'
import { isDirty, planSave, sanitizeBlocks, stableStringify } from './docjson'
import { h, showModal, toast, type ModalButton } from './dom'
import { openMenu, type MenuItem } from './views/menu'

const LANGUAGE_SUGGESTIONS = [
  'go', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'rust', 'shell', 'bash', 'sql', 'json', 'yaml', 'html', 'css', 'xml',
  'markdown', 'diff', 'php', 'ruby', 'kotlin', 'swift', 'text',
]

/**
 * 图片节点（见 image-ext.ts）：思源把图片的排版信息放在节点 Properties 里，
 * parent-style 决定“一行挤几张”（width: 25%），style 决定缩放尺寸。
 * 放在单独模块里，让逻辑自测跑的是同一份 schema。
 */

export interface EditorHandle {
  /** 编辑器整体（含工具条） */
  element: HTMLElement
  isDirty: () => boolean
  getBlocks: () => SaveBlock[]
  isSaving: () => boolean
  setSaving: (value: boolean) => void
  /** 保存成功后调用：把「已保存」基准挪到当前内容（脏标记归零） */
  /**
   * 保存成功后复位「已保存」基准。
   * - `sent`：本次真正发出去的块（用它当基准，而不是当前内容——请求在途时用户可能又打了字，
   *   那些字还没存过，不能算已保存）
   * - `saved`：服务端回填的权威块表（新建块的真实 id 在这里），不更新的话新块每次保存都会换 id
   */
  markSaved: (sent?: SaveBlock[], saved?: Block[]) => void
  /** 定位到某个块（搜索结果跳转）：滚过去并闪一下，找不到返回 false */
  revealBlock: (blockId: string) => boolean
  /** 当前内容里有多少个编辑器看不懂的块（>0 时页头提示可「原样预览」） */
  unsupported: () => number
  destroy: () => void
}

interface ToolItem {
  id: string
  label: string
  title: string
  run: (editor: Editor) => void
  active?: (editor: Editor) => boolean
}

/** 正文右键菜单的条目定义：图标列用工具条上的短标签，文字用中文名，右侧给快捷键。 */
const CTX_ITEMS: Record<string, { label: string; hint?: string }> = {
  undo: { label: '撤销', hint: 'Ctrl+Z' },
  redo: { label: '重做', hint: 'Ctrl+Shift+Z' },
  bold: { label: '加粗', hint: 'Ctrl+B' },
  italic: { label: '斜体', hint: 'Ctrl+I' },
  strike: { label: '删除线' },
  code: { label: '行内代码', hint: 'Ctrl+E' },
  h1: { label: '一级标题', hint: 'Ctrl+Alt+1' },
  h2: { label: '二级标题', hint: 'Ctrl+Alt+2' },
  h3: { label: '三级标题', hint: 'Ctrl+Alt+3' },
  bulletList: { label: '无序列表', hint: 'Ctrl+Shift+8' },
  orderedList: { label: '有序列表', hint: 'Ctrl+Shift+7' },
  blockquote: { label: '引用', hint: 'Ctrl+Shift+B' },
  codeBlock: { label: '代码块', hint: 'Ctrl+Alt+C' },
  horizontalRule: { label: '分隔线' },
  link: { label: '插入 / 修改链接', hint: 'Ctrl+K' },
  image: { label: '插入图片' },
  table: { label: '插入表格' },
}

/** 正文右键菜单：常用格式 + 剪贴板 + 撤销重做（表格里再多一排表格操作）。 */
function buildContextMenu(editor: Editor): MenuItem[] {
  const toolOf = (id: string) => TOOLS.find((t) => t !== 'sep' && t.id === id) as ToolItem | undefined
  const item = (id: string): MenuItem | null => {
    const tool = toolOf(id)
    const meta = CTX_ITEMS[id]
    if (!tool || !meta) return null
    return {
      icon: tool.label,
      label: meta.label,
      hint: meta.hint,
      onClick: () => {
        tool.run(editor)
        editor.commands.focus()
      },
    }
  }
  const items: MenuItem[] = []
  const push = (entry: MenuItem | null) => {
    if (entry) items.push(entry)
  }

  push(item('undo'))
  push(item('redo'))
  items.push({ separator: true })
  push({
    icon: '✂️',
    label: '剪切',
    hint: 'Ctrl+X',
    onClick: () => {
      editor.commands.focus()
      document.execCommand('cut')
    },
  })
  push({
    icon: '📋',
    label: '复制',
    hint: 'Ctrl+C',
    onClick: () => {
      editor.commands.focus()
      document.execCommand('copy')
    },
  })
  push({
    icon: '📥',
    label: '粘贴',
    hint: 'Ctrl+V',
    onClick: () => void pasteFromClipboard(editor),
  })
  push({
    icon: '🔤',
    label: '全选',
    hint: 'Ctrl+A',
    onClick: () => editor.chain().focus().selectAll().run(),
  })
  items.push({ separator: true })
  for (const id of ['bold', 'italic', 'strike', 'code']) push(item(id))
  items.push({ separator: true })
  for (const id of ['h1', 'h2', 'h3']) push(item(id))
  items.push({ separator: true })
  for (const id of ['bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule']) push(item(id))
  items.push({ separator: true })
  for (const id of ['link', 'image', 'table']) push(item(id))

  if (editor.isActive('table')) {
    items.push({ separator: true })
    for (const action of TABLE_ACTIONS) {
      items.push({
        icon: '▦',
        label: action.title,
        onClick: () => {
          action.run(editor)
          editor.commands.focus()
        },
      })
    }
  }
  return items
}

/** 读剪贴板并插入（浏览器不给权限时就提示用 Ctrl+V）。 */
async function pasteFromClipboard(editor: Editor): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) editor.chain().focus().insertContent(text).run()
  } catch {
    toast('浏览器不允许读剪贴板，请用 Ctrl+V 粘贴', 'error')
  }
}

// 搜索定位高亮：装饰器由 ProseMirror 管理，重绘不会把它抹掉（直接改 DOM 属性则会被节点替换丢掉）
const FLASH_META = 'ztnote-flash'
const flashPlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  key: new PluginKey('ztnote-flash'),
  state: {
    init: () => DecorationSet.empty,
    apply(tr, old) {
      const meta = tr.getMeta(FLASH_META)
      if (meta === null) return DecorationSet.empty
      if (meta instanceof DecorationSet) return meta.map(tr.mapping, tr.doc)
      return old.map(tr.mapping, tr.doc)
    },
  },
  props: {
    decorations(state) {
      return this.getState(state)
    },
  },
})

// TipTap 的 extensions 只吃 Extension/Node/Mark，原生 PM 插件要包一层
const FlashExtension = Extension.create({
  name: 'ztnoteFlash',
  addProseMirrorPlugins: () => [flashPlugin],
})

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
  {
    id: 'table',
    label: '表格',
    title: '插入 3×3 表格（首行为表头）',
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    active: (e) => e.isActive('table'),
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

// 光标落在表格里才出现的第二排按钮（参考思源的浮层表格工具栏）
const TABLE_ACTIONS: Array<{ id: string; label: string; title: string; run: (e: Editor) => boolean }> = [
  {
    id: 'rowAfter',
    label: '下方插行',
    title: '在当前行下方插入一行',
    run: (e) => e.chain().focus().addRowAfter().run(),
  },
  {
    id: 'deleteRow',
    label: '删行',
    title: '删除当前行',
    run: (e) => e.chain().focus().deleteRow().run(),
  },
  {
    id: 'colAfter',
    label: '右侧插列',
    title: '在当前列右侧插入一列',
    run: (e) => e.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'deleteCol',
    label: '删列',
    title: '删除当前列',
    run: (e) => e.chain().focus().deleteColumn().run(),
  },
  {
    id: 'headerRow',
    label: '表头行',
    title: '首行是否为表头（切换）',
    run: (e) => e.chain().focus().toggleHeaderRow().run(),
  },
  {
    id: 'merge',
    label: '合并',
    title: '合并选中的单元格',
    run: (e) => e.chain().focus().mergeCells().run(),
  },
  {
    id: 'split',
    label: '拆分',
    title: '拆分当前单元格',
    run: (e) => e.chain().focus().splitCell().run(),
  },
  {
    id: 'deleteTable',
    label: '删表格',
    title: '删除整个表格',
    run: (e) => e.chain().focus().deleteTable().run(),
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

export function createEditor(opts: { blocks: Block[]; onChange?: () => void }): EditorHandle {
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
  // 光标进表格时才出现的一排操作（默认隐藏，避免常驻工具条太长）
  const tableBar = h('div', { class: 'tb-tablebar' })
  const element = h(
    'div',
    { class: 'zt-editor' },
    toolbar,
    tableBar,
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
      ...tableExtensions(),
      FlashExtension,
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

  let initialKey = stableStringify(editor.getJSON().content ?? [])
  let saving = false

  // 内容变了就叫一声（doc.ts 用它做防抖自动保存）
  if (opts.onChange) {
    editor.on('update', () => opts.onChange?.())
  }

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

  for (const item of TABLE_ACTIONS) {
    tableBar.appendChild(
      h(
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
      ),
    )
  }

  let langTimer = 0
  let flashTimer = 0
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
    const inTable = editor.isActive('table')
    tableBar.classList.toggle('is-open', inTable)
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

  // 正文右键菜单：先把光标挪到点击处（否则格式操作会作用在旧位置），再弹常用命令
  editorHost.addEventListener('contextmenu', (e: MouseEvent) => {
    const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
    if (typeof pos === 'number') editor.commands.setTextSelection(pos)
    e.preventDefault()
    openMenu(e.clientX, e.clientY, buildContextMenu(editor))
  })

  // 图片地址补上会话令牌（Cookie 被飞牛 App 的 WebView 拦掉时，粘贴进来的图也能立刻显示）；
  // 只改 DOM，不改文档内容，存盘时 api.saveDoc 还会再清一道。
  pinAssetTokens(editorHost, true)

  return {
    element,
    isDirty: () => isDirty(editor.getJSON().content, initialKey),
    getBlocks: () => planSave(editor.getJSON().content ?? [], sanitized.baseline),
    isSaving: () => saving,
    setSaving: (value: boolean) => {
      saving = value
    },
    markSaved: (sent?: SaveBlock[], saved?: Block[]) => {
      const pm = sent?.length ? sent.map((b) => b.pm) : editor.getJSON().content ?? []
      initialKey = stableStringify(pm)
      if (sent?.length) {
        // 基准必须与编辑器顶层节点一一对应（revealBlock 按 baseline 下标定位），
        // 所以用 sent 的形状 + 服务端回填的真实 id（新建块上一轮还是 id:null，
        // 不补上就会每次保存都换 id）。降级文档（一个块拆成多个节点）长度对不上，
        // 宁可只保留 sent 自己的 id，也不打乱下标
        const same = saved && saved.length === sent.length ? saved : null
        sanitized.baseline = sent.map((b, i) => ({
          id: (same?.[i]?.id || b.id) ?? null,
          type: same?.[i]?.type || b.type,
          pm: b.pm,
        }))
      }
    },
    unsupported: () => sanitized.unsupportedBlocks,
    revealBlock: (blockId: string) => {
      const idx = sanitized.baseline.findIndex((b) => b.id === blockId)
      if (idx < 0) return false
      const doc = editor.state.doc
      if (idx >= doc.childCount) return false
      // 顶层第 idx 个块的起点（内容位置从 0 算起，块 i 占 [from, from+nodeSize)）
      let from = 0
      for (let i = 0; i < idx; i++) from += doc.child(i).nodeSize
      const to = from + doc.child(idx).nodeSize
      // 高亮必须走 ProseMirror 装饰器：直接改 DOM 属性的话，PM 下一次重绘该块
      // 会把节点整个换掉（实测挂载后几十毫秒内就会发生），标记就没了。
      try {
        const deco = Decoration.node(from, to, { class: 'block-flash', 'data-block-id': blockId })
        editor.view.dispatch(
          editor.state.tr.setMeta(FLASH_META, DecorationSet.create(doc, [deco])).setMeta('addToHistory', false),
        )
      } catch {
        return false
      }
      window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => {
        editor.view.dispatch(editor.state.tr.setMeta(FLASH_META, null))
      }, 2400)
      const at = editor.view.nodeDOM(from)
      let dom: HTMLElement | null = at instanceof HTMLElement ? at : ((at as Node | null)?.parentElement ?? null)
      while (dom && dom.parentElement && dom.parentElement !== editor.view.dom) dom = dom.parentElement
      if (dom && typeof dom.scrollIntoView === 'function') dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return true
    },
    destroy: () => {
      window.clearTimeout(langTimer)
      window.clearTimeout(flashTimer)
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
