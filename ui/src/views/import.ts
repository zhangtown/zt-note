// 导入向导：#/import —— 上传 zip / 服务器目录路径
import { api } from '../api'
import { clear, h, toast } from '../dom'
import type { ImportResp } from '../types'
import type { ViewHandle } from './doc'

export interface ImportCtx {
  refreshTree: () => Promise<void>
}

export function mountImport(main: HTMLElement, ctx: ImportCtx): ViewHandle {
  let destroyed = false
  const root = h('div', { class: 'page import-page' })
  clear(main)
  main.appendChild(root)

  root.appendChild(
    h(
      'div',
      { class: 'page-header' },
      h('h1', { class: 'page-title' }, '导入笔记'),
      h(
        'div',
        { class: 'page-meta muted' },
        '支持两种来源：① 思源导出的 zip / 完整 data 目录（含 .sy，按原样 1:1 保留）；② markdown-export 结构的 zip（含 .md，逐个转成思源文档）。',
      ),
    ),
  )

  const resultBox = h('div', { class: 'import-result' })
  const showResult = (res: ImportResp): void => {
    clear(resultBox)
    resultBox.appendChild(renderResult(res))
    resultBox.scrollIntoView({ block: 'nearest' })
  }

  /* ---- ① 上传 zip ---- */
  const fileInput = h('input', { class: 'hidden-file', type: 'file', accept: '.zip,application/zip' })
  const fileName = h('span', { class: 'file-name muted' }, '未选择文件')
  const uploadBtn = h(
    'button',
    { class: 'btn primary', type: 'button', disabled: 'true' },
    '上传并导入',
  ) as HTMLButtonElement
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-inner' }))
  const barInner = bar.firstElementChild as HTMLElement
  bar.classList.add('is-hidden')

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileName.textContent = file ? `${file.name}（${formatSize(file.size)}）` : '未选择文件'
    uploadBtn.disabled = !file
  })

  uploadBtn.addEventListener('click', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    uploadBtn.disabled = true
    uploadBtn.textContent = '导入中…'
    bar.classList.remove('is-hidden')
    barInner.style.width = '0%'
    api
      .importUpload(file, (percent) => {
        barInner.style.width = `${percent}%`
      })
      .then(async (res) => {
        toast('导入完成', 'ok')
        showResult(res)
        await ctx.refreshTree()
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : '导入失败', 'error', 6000)
        showResult({ ok: false, error: err instanceof Error ? err.message : '导入失败' })
      })
      .finally(() => {
        if (destroyed) return
        uploadBtn.disabled = false
        uploadBtn.textContent = '上传并导入'
        bar.classList.add('is-hidden')
      })
  })

  const uploadCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-title' }, '① 上传 zip 文件'),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, '选择 zip 文件…'),
        fileName,
        fileInput,
        uploadBtn,
      ),
      bar,
      h(
        'ul',
        { class: 'tips' },
        h('li', null, '思源「data 目录」打包的 zip，或工作区导出的 zip（含 .siyuan/conf.json 会带出笔记本名）。'),
        h('li', null, 'markdown-export 结构的 zip：<笔记本名>/<标题>.md + assets/。'),
        h('li', null, '单个「全部笔记汇总.md」也可以，会按一级标题拆成多篇文档。'),
        h('li', null, 'zip 内的 assets/ 会解到 data/assets/，正文里的相对图片路径保持不变。'),
      ),
    ),
  )

  /* ---- ② 服务器目录 ---- */
  const pathInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '例如 /vol1/1000/notes/markdown-export 或 D:/notes/data',
  }) as HTMLInputElement
  const pathBtn = h('button', { class: 'btn primary', type: 'button' }, '导入该目录')
  pathBtn.addEventListener('click', () => {
    const path = pathInput.value.trim()
    if (!path) {
      toast('请填写服务器上的目录路径', 'error')
      return
    }
    pathBtn.disabled = true
    pathBtn.textContent = '导入中…'
    api
      .importPath(path)
      .then(async (res) => {
        toast('导入完成', 'ok')
        showResult(res)
        await ctx.refreshTree()
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : '导入失败', 'error', 6000)
        showResult({ ok: false, error: err instanceof Error ? err.message : '导入失败' })
      })
      .finally(() => {
        if (destroyed) return
        pathBtn.disabled = false
        pathBtn.textContent = '导入该目录'
      })
  })
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pathBtn.click()
  })

  const pathCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-title' }, '② 导入 NAS 上已有的目录'),
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'row' }, pathInput, pathBtn),
      h(
        'ul',
        { class: 'tips' },
        h('li', null, '目录在服务器（NAS）上，必须是后端进程能读到的绝对路径。'),
        h('li', null, '目录里可以是思源 data 目录（含 <boxID>/*.sy），也可以是一堆 .md。'),
        h('li', null, '导入是复制，不会改动源目录。'),
      ),
    ),
  )

  /* ---- 结果 ---- */
  const resultCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-title' }, '导入结果'),
    resultBox,
  )
  resultBox.appendChild(h('div', { class: 'muted' }, '还没有执行导入。'))

  root.appendChild(uploadCard)
  root.appendChild(pathCard)
  root.appendChild(resultCard)
  return {
    destroy: () => {
      destroyed = true
      root.remove()
    },
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function pick(obj: ImportResp, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key]
  }
  return undefined
}

function pickNumber(obj: ImportResp, keys: string[]): number | undefined {
  const value = pick(obj, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (Array.isArray(value)) return value.length
  return undefined
}

/** 契约没有固定导入响应结构，这里做宽容渲染：常见字段翻译成人话，原文折叠展示。 */
function renderResult(res: ImportResp): HTMLElement {
  const wrap = h('div', { class: 'import-result-body' })
  if (res.ok === false || res.error) {
    wrap.appendChild(h('div', { class: 'result-error' }, `导入失败：${res.error ?? '未知错误'}`))
    return wrap
  }
  const rawFormat = pick(res, ['format', 'kind', 'source', 'type', 'mode', 'detected'])
  const formatText =
    typeof rawFormat === 'string'
      ? /siyuan|sy|思源/i.test(rawFormat)
        ? '思源格式（.sy）'
        : /md|markdown/i.test(rawFormat)
          ? 'Markdown 格式（.md → .sy）'
          : rawFormat
      : '—'
  const notebooks = pickNumber(res, ['notebooks', 'notebookCount', 'boxCount', 'boxes'])
  const docs = pickNumber(res, ['docs', 'documents', 'docCount', 'imported', 'count', 'total', 'files'])
  const assets = pickNumber(res, ['assets', 'assetCount', 'images'])

  const lines: Array<[string, string]> = [['识别结果', formatText]]
  if (notebooks !== undefined) lines.push(['笔记本', `${notebooks} 个`])
  if (docs !== undefined) lines.push(['导入文档', `${docs} 篇`])
  if (assets !== undefined) lines.push(['资源文件', `${assets} 个`])

  wrap.appendChild(
    h(
      'div',
      { class: 'result-grid' },
      ...lines.map(([k, v]) => h('div', { class: 'result-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v))),
    ),
  )

  const warnings = pick(res, ['warnings', 'skipped', 'errors'])
  if (Array.isArray(warnings) && warnings.length) {
    wrap.appendChild(h('div', { class: 'result-sub' }, '警告 / 跳过'))
    wrap.appendChild(
      h(
        'ul',
        { class: 'result-list' },
        ...warnings.slice(0, 50).map((item) => h('li', null, String(item))),
      ),
    )
  }

  const created = pick(res, ['created', 'importedDocs', 'docs_created'])
  if (Array.isArray(created) && created.length) {
    wrap.appendChild(h('div', { class: 'result-sub' }, `新增文档（${created.length}）`))
    wrap.appendChild(
      h(
        'ul',
        { class: 'result-list' },
        ...created.slice(0, 100).map((item) => h('li', null, String(item))),
      ),
    )
  }

  wrap.appendChild(
    h(
      'details',
      { class: 'raw-details' },
      h('summary', null, '后端原始返回'),
      h('pre', { class: 'raw-json' }, JSON.stringify(res, null, 2)),
    ),
  )
  return wrap
}
