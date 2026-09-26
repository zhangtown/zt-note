// 与 docs/API.md 契约对应的类型定义。
import type { JSONContent } from '@tiptap/core'

export interface HealthResp {
  ok: boolean
  version: string
  dataDir: string
  prefix?: string
}

export interface DocNode {
  id: string
  title: string
  updated?: string
  children?: DocNode[]
}

export interface Notebook {
  id: string
  name: string
  icon?: string
  docs: DocNode[]
}

export interface TreeResp {
  notebooks: Notebook[]
}

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'codeBlock'
  | 'blockquote'
  | 'bulletList'
  | 'orderedList'
  | 'image'
  | 'thematicBreak'
  | 'table'
  | string

export interface Block {
  id: string | null
  type: BlockType
  /** heading 的级别，后端可选返回 */
  level?: number
  pm: JSONContent
}

export interface DocResp {
  id: string
  box: string
  title: string
  updated?: string
  readonly?: boolean
  html: string
  blocks: Block[]
}

/** POST api/doc/save 的单块结构 */
export interface SaveBlock {
  id: string | null
  pm: JSONContent
  changed: boolean
  type: string
}

export interface SearchHit {
  box: string
  id: string
  title: string
  blockId?: string
  snippet: string
}

export interface SearchResp {
  hits: SearchHit[]
}

/** 导入结果：契约未固定字段，前端做宽容解析 */
export interface ImportResp {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

export type CurrentSelection =
  | { kind: 'box'; box: string }
  | { kind: 'doc'; box: string; id: string }
