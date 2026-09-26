// 块级保真逻辑：
// 1) sanitize —— 把后端给的 pm 节点对齐到前端 TipTap schema，剔除未知节点/标记，
//    避免 schema 不认识某个节点时整个编辑器崩掉；被降级的内容只要用户没改，
//    保存时仍按 changed:false + 原块 ID 交回后端，由后端复用原始 .sy 节点（零损失）。
// 2) planSave —— 用 LCS 对齐「当前编辑器顶层节点」与「初始块」，未变动的块保 id 且 changed:false，
//    变动的块保 id 且 changed:true，新增块 id=null，缺失的块不下发（视为删除）。
import type { JSONContent } from '@tiptap/core'
import type { SaveBlock, Block } from './types'

export interface NodeTypeLike {
  isInline?: boolean
  isTextblock?: boolean
}

export interface SchemaLike {
  nodes: Record<string, NodeTypeLike | undefined>
  marks: Record<string, unknown>
}

type Ctx = 'block' | 'inline' | 'code'

/** 稳定序列化：对象键排序，用于深度相等比较。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 递归取出节点里的纯文本（用于不受支持节点的降级占位）。 */
export function inlineText(json: JSONContent): string {
  if (json.type === 'text') return asText(json.text)
  if (json.type === 'hardBreak') return '\n'
  let out = ''
  for (const child of json.content ?? []) {
    out += inlineText(child)
    if (
      child.type === 'paragraph' ||
      child.type === 'tableCell' ||
      child.type === 'listItem' ||
      child.type === 'blockquote'
    ) {
      out += ' '
    }
  }
  return out
}

function textNode(text: string): JSONContent {
  return { type: 'text', text }
}

function paragraphsFromText(text: string): JSONContent[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraph', content: [textNode(line)] }) as JSONContent)
}

/** 表格在 v1 编辑器里不受支持：降级成「每行一段、单元格用 | 分隔」的占位文本。 */
function tableToParagraphs(json: JSONContent): JSONContent[] {
  const out: JSONContent[] = []
  for (const row of json.content ?? []) {
    const cells = (row.content ?? []).map((cell) => inlineText(cell).replace(/\s+/g, ' ').trim())
    const line = cells.join(' | ').trim()
    if (line) out.push({ type: 'paragraph', content: [textNode(line)] })
  }
  return out
}

interface SanitizeResult {
  nodes: JSONContent[]
  unsupported: number
}

function sanitizeNode(schema: SchemaLike, json: JSONContent | null | undefined, ctx: Ctx): SanitizeResult {
  if (!json || typeof json.type !== 'string') return { nodes: [], unsupported: 0 }
  const typeName = json.type
  const type = schema.nodes[typeName]

  // 文本节点
  if (typeName === 'text' || !typeName) {
    const text = asText(json.text)
    if (!text) return { nodes: [], unsupported: 0 }
    if (ctx === 'code') return { nodes: [textNode(text)], unsupported: 0 }
    const marks = (json.marks ?? []).filter(
      (mark) => mark && typeof mark.type === 'string' && Boolean(schema.marks[mark.type]),
    )
    const node: JSONContent = { type: 'text', text }
    if (marks.length) node.marks = marks.map((mark) => ({ type: mark.type, attrs: mark.attrs }))
    return { nodes: [node], unsupported: 0 }
  }

  // 未知节点：降级为纯文本（保持可读，且未改动会被 changed:false 原样保留）
  if (!type) {
    if (ctx === 'inline') {
      const text = inlineText(json)
      return text
        ? { nodes: [textNode(text)], unsupported: 1 }
        : { nodes: [], unsupported: 1 }
    }
    const text = inlineText(json)
    if (typeName === 'table') {
      const nodes = tableToParagraphs(json)
      return { nodes, unsupported: 1 }
    }
    const nodes = paragraphsFromText(text)
    if (!nodes.length) {
      return { nodes: [{ type: 'paragraph' }], unsupported: 1 }
    }
    return { nodes, unsupported: 1 }
  }

  // 已知节点，但方向不对：行内节点出现在块位置 → 包一层段落；块节点出现在行内位置 → 摊平子节点
  if (ctx === 'block' && type.isInline) {
    const inner = sanitizeChildren(schema, json.content, 'inline')
    return { nodes: [{ type: 'paragraph', content: inner.nodes }], unsupported: inner.unsupported }
  }
  if (ctx !== 'block' && type.isInline === false && type.isTextblock !== true && typeName !== 'image') {
    const inner = sanitizeChildren(schema, json.content, 'inline')
    return { nodes: inner.nodes, unsupported: inner.unsupported }
  }

  const childCtx: Ctx = typeName === 'codeBlock' ? 'code' : type.isTextblock ? 'inline' : 'block'
  const inner = sanitizeChildren(schema, json.content, childCtx)
  const node: JSONContent = { type: typeName }
  if (json.attrs) node.attrs = { ...json.attrs }
  if (inner.nodes.length) node.content = inner.nodes
  return { nodes: [node], unsupported: inner.unsupported }
}

function sanitizeChildren(
  schema: SchemaLike,
  children: JSONContent[] | undefined,
  ctx: Ctx,
): SanitizeResult {
  const nodes: JSONContent[] = []
  let unsupported = 0
  for (const child of children ?? []) {
    const res = sanitizeNode(schema, child, ctx)
    unsupported += res.unsupported
    nodes.push(...res.nodes)
  }
  return { nodes, unsupported }
}

export interface SanitizedBlocks {
  /** 供编辑器初始化的顶层节点（与后端块顺序一致） */
  content: JSONContent[]
  /** 用于保存比对的基准（只有带可用块 ID 的块才能走 changed:false 保真通道） */
  baseline: Block[]
  /** 含不受支持结构的块数量（表格等），用于提示用户 */
  unsupportedBlocks: number
}

export function sanitizeBlocks(schema: SchemaLike, blocks: Block[]): SanitizedBlocks {
  const content: JSONContent[] = []
  const baseline: Block[] = []
  let unsupportedBlocks = 0
  for (const block of blocks) {
    const res = sanitizeNode(schema, block.pm, 'block')
    if (res.unsupported > 0) unsupportedBlocks += 1
    const id = typeof block.id === 'string' && block.id ? block.id : ''
    const type =
      block.pm && typeof block.pm.type === 'string' && block.pm.type ? block.pm.type : block.type
    // 一个原始块可能被拆成多个（表格降级等）：第一段继承块 ID，其余视为新块。
    if (!res.nodes.length) {
      baseline.push({ id, type, pm: { type: type ?? 'paragraph' } })
      continue
    }
    res.nodes.forEach((node, idx) => {
      content.push(node)
      baseline.push({
        id: idx === 0 ? id : '',
        type: idx === 0 ? type : (node.type ?? 'paragraph'),
        pm: node,
      })
    })
  }
  return { content, baseline, unsupportedBlocks }
}

/** 当前编辑器内容与初始内容是否有差异。 */
export function isDirty(current: JSONContent[] | undefined, initialKey: string): boolean {
  return stableStringify(current ?? []) !== initialKey
}

const MAX_LCS_CELLS = 2_000_000

/** LCS 对齐（返回 [当前下标, 初始下标] 的严格相等配对）。 */
function align(curKeys: string[], baseKeys: string[]): Array<[number, number]> {
  const n = curKeys.length
  const m = baseKeys.length
  const anchors: Array<[number, number]> = []
  if (n * m > MAX_LCS_CELLS) {
    // 文档过大时退化为按下标比对（保持可用，只是插入场景会更保守）
    for (let i = 0; i < Math.min(n, m); i++) {
      if (curKeys[i] === baseKeys[i]) anchors.push([i, i])
    }
    return anchors
  }
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        curKeys[i] === baseKeys[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (curKeys[i] === baseKeys[j]) {
      anchors.push([i, j])
      i++
      j++
      continue
    }
    if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) i++
    else j++
  }
  return anchors
}

function typeOf(pm: JSONContent): string {
  return typeof pm.type === 'string' && pm.type ? pm.type : 'paragraph'
}

/**
 * 生成 POST api/doc/save 的 blocks。
 * - 与初始块深度相等 → changed:false（带原块 ID，后端复用原始 .sy 节点）
 * - 有变动但属于同一块 → changed:true（保留块 ID）
 * - 新增节点 → id:null
 * - 被删掉的块不出现
 */
export function planSave(current: JSONContent[], baseline: Block[]): SaveBlock[] {
  const curKeys = current.map((node) => stableStringify(node))
  const baseKeys = baseline.map((block) => stableStringify(block.pm))
  const anchors = align(curKeys, baseKeys)
  const out: SaveBlock[] = []
  let ci = 0
  let bi = 0

  const flushRun = (curEnd: number, baseEnd: number) => {
    const paired = Math.min(curEnd - ci, baseEnd - bi)
    for (let t = 0; t < paired; t++) {
      const node = current[ci + t]
      const base = baseline[bi + t]
      out.push({ id: base.id || null, pm: node, changed: true, type: typeOf(node) })
    }
    for (let t = paired; t < curEnd - ci; t++) {
      const node = current[ci + t]
      out.push({ id: null, pm: node, changed: true, type: typeOf(node) })
    }
    // baseEnd-bi 中多出来的初始块 = 被删除，不下发
    ci = curEnd
    bi = baseEnd
  }

  for (const [ai, aj] of anchors) {
    flushRun(ai, aj)
    const base = baseline[aj]
    const node = current[ai]
    if (base.id) {
      out.push({ id: base.id, pm: node, changed: false, type: base.type || typeOf(node) })
    } else {
      out.push({ id: null, pm: node, changed: true, type: typeOf(node) })
    }
    ci = ai + 1
    bi = aj + 1
  }
  flushRun(current.length, baseline.length)
  return out
}
