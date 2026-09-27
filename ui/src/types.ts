// 与 docs/API.md 契约对应的类型定义。
import type { JSONContent } from '@tiptap/core'

export interface HealthResp {
  ok: boolean
  version: string
  dataDir: string
  prefix?: string
  dataRoot?: string
  frontend?: boolean
  user?: UserInfo
  needsPin?: boolean
  locked?: boolean
  users?: number
}

/** 当前请求的身份（来自飞牛网关头；本地开发时是 local）。 */
export interface UserInfo {
  uid: string
  name: string
  isAdmin: boolean
  local: boolean
}

/** GET api/session：前端靠它决定先显示 PIN 屏还是主界面。 */
export interface SessionResp {
  version: string
  prefix?: string
  user: UserInfo
  /** 还没设过 PIN */
  needsSetup: boolean
  /** 已设 PIN 但本设备未解锁 */
  locked: boolean
  /** 数据目录里已经有笔记库 */
  hasLibrary: boolean
  dataDir?: string
  stats?: Stats
  /** 该账号当前有几枚有效会话（含本机） */
  sessions?: number
  /** 本次解锁的到期时间（RFC3339，UTC） */
  sessionExpiresAt?: string
}

export interface Stats {
  notebooks: number
  docs: number
  blocks: number
  chars: number
  assets: number
}

/** PIN 接口的返回：onboarded 表示这次刚建好新手库。 */
export interface PinResp {
  user: UserInfo
  onboarded?: boolean
  weak?: boolean
  locked?: boolean
  /** 撤销其它设备时被作废的会话数（不含本机） */
  revoked?: number
  /** 撤销后本账号剩下的会话数 */
  sessions?: number
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
