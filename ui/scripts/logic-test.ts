// 块模型逻辑自测（无浏览器、无后端）：
// 用真实的 TipTap schema 跑 sanitizeBlocks / planSave / isDirty，
// 校验「保持不变 → changed:false + 原 ID」「改动 → changed:true + 原 ID」
// 「新增 → id:null」「删除 → 不出现在下发列表」这四条与 docs/API.md 的约定。
//
// 运行：npm run test:logic
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { ImageWithLayout } from '../src/image-ext'
import { tableExtensions } from '../src/table-ext'
import { isDirty, planSave, sanitizeBlocks, stableStringify } from '../src/docjson'
import { api, clearToken, readToken, saveToken, tokenValue, withToken } from '../src/api'
import {
  DEFAULT_AUTOLOCK_MINUTES,
  autoLockLabel,
  normalizeAutoLock,
  readAutoLockMinutes,
  shouldAutoLock,
  writeAutoLockMinutes,
} from '../src/autolock'
import type { Block } from '../src/types'

let failed = 0
let passed = 0

function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const schema = getSchema([
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    codeBlock: { languageClassPrefix: 'language-', defaultLanguage: null },
  }),
  Link,
  ImageWithLayout.configure({ inline: true, allowBase64: false }),
  ...tableExtensions(),
])

const blocks: Block[] = [
  { id: 'b1', type: 'paragraph', pm: { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] } },
  {
    id: 'b2',
    type: 'heading',
    level: 2,
    pm: { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题二' }] },
  },
  {
    id: 'b3',
    type: 'codeBlock',
    pm: {
      type: 'codeBlock',
      attrs: { language: 'go' },
      content: [{ type: 'text', text: 'fmt.Println("hi")' }],
    },
  },
  {
    // 表格（思源 NodeTable）：装了 TipTap 表格扩展后是真表格，不再降级
    id: 'b4',
    type: 'table',
    pm: {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'D' }] }] }] },
      ],
    },
  },
  {
    // 未知标记：应被剔除
    id: 'b5',
    type: 'paragraph',
    pm: {
      type: 'paragraph',
      content: [{ type: 'text', text: '带未知标记', marks: [{ type: 'weirdMark', attrs: { x: 1 } }] }],
    },
  },
]

console.log('1) sanitizeBlocks —— 未知节点降级、原块顺序与 ID 保留')
const s = sanitizeBlocks(schema, blocks)
ok(s.content.length === 5, '5 个顶层节点（表格不再被拆成段落）', `实际 ${s.content.length}`)
ok(s.unsupportedBlocks === 0, '没有不受支持的块（表格已支持）', `实际 ${s.unsupportedBlocks}`)
ok(s.baseline[0].id === 'b1' && s.baseline[1].id === 'b2' && s.baseline[2].id === 'b3', '前 3 块 ID 保持 b1/b2/b3')
ok(s.baseline[3].id === 'b4' && s.content[3].type === 'table', '表格整块保留，ID 仍是 b4')
const table = s.content[3]
ok(table.content?.length === 2, '表格保留 2 行', JSON.stringify(table.content?.length))
ok(
  table.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text === 'C',
  '第 2 行第 1 格文本 C 保留',
  JSON.stringify(table.content?.[1]?.content?.[0]),
)
ok(
  (table.content?.[1]?.content?.[0]?.attrs as { rowspan?: number } | undefined)?.rowspan === 2,
  '合并单元格的 rowspan 保留',
)
ok(
  (table.content?.[0]?.content?.[1]?.attrs as { colspan?: number } | undefined)?.colspan === 1,
  '缺失的 colspan 补成默认值 1（与编辑器 getJSON 对齐，不因少个属性就误判改过）',
)
const codeNode = s.content[2]
ok(codeNode.type === 'codeBlock' && codeNode.attrs?.language === 'go', '代码块语言 go 保留', JSON.stringify(codeNode.attrs))
const marked = s.content[4]
ok(!JSON.stringify(marked).includes('weirdMark'), '未知标记被剔除')
ok(typeof schema.nodes.paragraph !== 'undefined', 'schema 已就绪（含 paragraph）')

console.log('\n2) isDirty —— 深度相等判定')
const initialKey = stableStringify(s.content)
ok(isDirty(s.content, initialKey) === false, '同一内容不脏')
ok(isDirty([...s.content, { type: 'paragraph' }], initialKey) === true, '追加节点后判定为脏')

console.log('\n3) planSave —— 未改动：全部 changed:false 且带原 ID')
const untouched = planSave(s.content, s.baseline)
ok(untouched[0].id === 'b1' && untouched[0].changed === false, 'b1 changed:false + 原 ID')
ok(untouched[2].id === 'b3' && untouched[2].changed === false, 'b3 changed:false + 原 ID')
ok(untouched[3].id === 'b4' && untouched[3].changed === false, '未改动的表格 changed:false + b4（后端复用原 .sy 表格节点）')
ok(untouched[4].id === 'b5' && untouched[4].changed === false, 'b5 changed:false + 原 ID')

console.log('\n4) planSave —— 改动：保留原 ID 且 changed:true')
const edited = s.content.map((node, i) =>
  i === 0 ? { type: 'paragraph', content: [{ type: 'text', text: '第一段（改过）' }] } : node,
)
const plan = planSave(edited, s.baseline)
ok(plan[0].id === 'b1' && plan[0].changed === true, 'b1 changed:true 且保留 ID')
ok(plan[1].id === 'b2' && plan[1].changed === false, '未改动的 b2 仍为 changed:false')
ok(plan[0].type === 'paragraph' && plan[0].pm.content?.[0]?.text === '第一段（改过）', 'type / pm 与编辑器节点一致')

console.log('\n5) planSave —— 新增：id:null；删除：不下发')
const inserted = planSave([{ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }, ...s.content], s.baseline)
ok(inserted[0].id === null && inserted[0].changed === true, '新增节点 id:null + changed:true')
ok(inserted[1].id === 'b1' && inserted[1].changed === false, '插入后原块仍对齐到 b1（changed:false）')
const removed = planSave(s.content.filter((_, i) => i !== 1), s.baseline)
ok(!removed.some((b) => b.id === 'b2'), '删除的块（b2）不出现在下发列表')
ok(removed.length === 4, '其余 4 块照常下发', `实际 ${removed.length}`)

console.log('\n6) 表格：改过就按 changed:true 整块下发（写回 .sy 用）')
const tableEdited = s.content.map((node, i) =>
  i === 3
    ? {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '名称' }] }], attrs: { colspan: 1, rowspan: 1, colwidth: null } },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '数量' }] }], attrs: { colspan: 1, rowspan: 1, colwidth: null } },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '苹果' }] }], attrs: { colspan: 1, rowspan: 1, colwidth: null } },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '3' }] }], attrs: { colspan: 1, rowspan: 1, colwidth: null } },
            ],
          },
        ],
      }
    : node,
)
const tablePlan = planSave(tableEdited, s.baseline)
ok(tablePlan[3].id === 'b4' && tablePlan[3].changed === true, '改过的表格 changed:true 且保留 ID b4')
ok(tablePlan[3].type === 'table', '下发的 type 是 table（后端按此写回 NodeTable）')
ok(JSON.stringify(tablePlan[3].pm).includes('"tableHeader"'), '表头单元格（tableHeader）在下发的节点里', JSON.stringify(tablePlan[3].pm).slice(0, 120))
ok(tablePlan[3].level === null || tablePlan[3].level === undefined, '表格没有标题级别')

console.log('\n7) 图片：排版属性保真 + 未改动不重建')
// 思源 .sy 里图片的 parent-style（一行几张）/ style（缩放尺寸）要一路带到保存。
// 编辑器 schema 会把缺失的属性补成默认值 null，基准必须同样补齐，
// 否则「打开含图片的文档、什么都没改」会被判成已改动，白白重建节点、丢掉原有属性。
const imgBlocks: Block[] = [
  {
    id: 'p1',
    type: 'paragraph',
    pm: {
      type: 'paragraph',
      content: [
        { type: 'text', text: '1月' },
        { type: 'image', attrs: { src: 'assets/a.png', alt: '一月' } },
      ],
    },
  },
  {
    id: 'p2',
    type: 'paragraph',
    pm: {
      type: 'paragraph',
      content: [
        { type: 'text', text: '2月' },
        {
          type: 'image',
          attrs: { src: 'assets/b.png', alt: '二月', parentStyle: 'width: 25%;', style: 'width: 10000px;' },
        },
      ],
    },
  },
]
const imgSan = sanitizeBlocks(schema, imgBlocks)
const imgAttrs = (i: number) => (imgSan.baseline[i].pm?.content?.[1]?.attrs ?? {}) as Record<string, unknown>
const a0 = imgAttrs(0)
const a1 = imgAttrs(1)
ok(
  stableStringify(a0) ===
    stableStringify({ src: 'assets/a.png', alt: '一月', title: null, parentStyle: null, style: null }),
  '缺省的图片属性在基准里补齐为 null（与编辑器 schema 一致）',
  JSON.stringify(a0),
)
ok(
  a1.parentStyle === 'width: 25%;' && a1.style === 'width: 10000px;',
  'parent-style / style 保留在基准里',
  JSON.stringify(a1),
)

// 编辑器 setContent → getJSON 的产物：属性都被物化出来
const imgEditorJSON = [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: '1月' },
      {
        type: 'image',
        attrs: { src: 'assets/a.png', alt: '一月', title: null, parentStyle: null, style: null },
      },
    ],
  },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: '2月' },
      {
        type: 'image',
        attrs: {
          src: 'assets/b.png',
          alt: '二月',
          title: null,
          parentStyle: 'width: 25%;',
          style: 'width: 10000px;',
        },
      },
    ],
  },
]
const imgPlan = planSave(imgEditorJSON, imgSan.baseline)
ok(
  imgPlan.every((b) => b.changed === false),
  '图片属性齐全时判定为未改动（不重建节点）',
  JSON.stringify(imgPlan.map((b) => b.changed)),
)

// 改了所在块的文字 → changed:true，但图片的排版属性要一路带到下发数据里
const imgEdited = imgEditorJSON.map((n, i) =>
  i === 1
    ? {
        type: 'paragraph',
        content: [
          { type: 'text', text: '2月（改）' },
          {
            type: 'image',
            attrs: {
              src: 'assets/b.png',
              alt: '二月',
              title: null,
              parentStyle: 'width: 25%;',
              style: 'width: 10000px;',
            },
          },
        ],
      }
    : n,
)
const imgPlan2 = planSave(imgEdited, imgSan.baseline)
ok(imgPlan2[1].changed === true && imgPlan2[1].id === 'p2', '改动图片所在块：changed:true 且保留原 ID')
ok(
  JSON.stringify(imgPlan2[1].pm).includes('width: 25%;'),
  '下发数据里仍带 parent-style',
  JSON.stringify(imgPlan2[1].pm),
)
ok(imgPlan2[0].changed === false, '同一文档里的其它块不受影响')

// ------------------------------------------------------------------ 闲置自动锁定

/** 假的 localStorage（只需要 getItem/setItem/removeItem） */
function fakeStore(
  init: Record<string, string> = {},
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

ok(DEFAULT_AUTOLOCK_MINUTES === 30, '默认闲置时长是 30 分钟')
ok(normalizeAutoLock(null) === 30, '没存过 → 默认')
ok(normalizeAutoLock('15') === 15, "存的是字符串 '15' → 15")
ok(normalizeAutoLock('abc') === 30, '垃圾值 → 回落默认')
ok(normalizeAutoLock('-5') === 30, '负数 → 回落默认')
ok(normalizeAutoLock('0') === 0, "0 表示永不（不回落默认）")
ok(normalizeAutoLock('7') === 30, '不在选项里的 7 分钟 → 回落默认')
ok(
  autoLockLabel(0) === '永不' && autoLockLabel(30) === '30 分钟' && autoLockLabel(180) === '3 小时',
  '时长文案',
  `${autoLockLabel(0)} / ${autoLockLabel(30)} / ${autoLockLabel(180)}`,
)
ok(autoLockLabel(120) === '2 小时', '非选项的整小时数也能读出来')

const st1 = fakeStore()
ok(writeAutoLockMinutes(60, st1) === 60 && readAutoLockMinutes(st1) === 60, '写入 60 分钟后能读回')
ok(
  writeAutoLockMinutes(999, st1) === 30 && readAutoLockMinutes(st1) === 30,
  '写入非法值也被规范化成默认值',
)
ok(readAutoLockMinutes(fakeStore({ 'zt.autolock.minutes': '0' })) === 0, '存 0 过夜后仍是永不')

const t0 = 1_700_000_000_000
ok(shouldAutoLock(t0, t0 + 29 * 60_000, 30) === false, '29 分钟不算闲置')
ok(shouldAutoLock(t0, t0 + 30 * 60_000, 30) === true, '正好 30 分钟算闲置')
ok(shouldAutoLock(t0, t0 + 15 * 60_000, 15) === true, '15 分钟档到点就锁')
ok(shouldAutoLock(t0, t0 + 99 * 3_600_000, 0) === false, '设为永不时多久都不锁')
ok(shouldAutoLock(Number.NaN, t0, 30) === false, '上次活动时间无效时不锁')

// ------------------------------------------------------------------ 会话令牌的多通道
//
// 场景：飞牛 App 把应用嵌在 WebView 里，Cookie 可能被当第三方拦掉或存不下。
// 这种时候令牌必须能从请求头（X-Zt-Token）与只读 URL 参数（?t=）走，
// 否则表现就是「PIN 明明输对了，却一直让重输」。

const apiStore = fakeStore()
const g = globalThis as unknown as { window?: unknown; fetch?: unknown }
g.window = { localStorage: apiStore }

clearToken()
saveToken('1000', 'tok-a')
ok(tokenValue() === 'tok-a', '保存令牌后能读回')
ok(readToken()?.uid === '1000', '同时记住是谁的令牌')
ok(apiStore.getItem('ztnote.token')?.includes('tok-a') === true, '令牌落到 localStorage（刷新后还能用）')
ok(
  withToken('api/export/md?box=abc') === 'api/export/md?box=abc&t=tok-a',
  '带查询串的地址用 & 续接令牌',
  withToken('api/export/md?box=abc'),
)
ok(withToken('assets/x.png') === 'assets/x.png?t=tok-a', '没有查询串时用 ? 接令牌')
ok(withToken(withToken('assets/x.png')) === 'assets/x.png?t=tok-a', '重复挂令牌不会叠出两个 t')

// 改 PIN / 撤销时只拿到新令牌、拿不到 uid：沿用先前那一个，不然诊断信息会丢
saveToken('', 'tok-b')
ok(tokenValue() === 'tok-b' && readToken()?.uid === '1000', '只给令牌时沿用已记住的 uid')
saveToken('1000', '')
ok(tokenValue() === 'tok-b', '空令牌不覆盖已有令牌')

// 请求头通道：所有 fetch 都要带上（Cookie 被拦时全靠它）
const seen: { url: string; init: RequestInit }[] = []
g.fetch = (url: unknown, init: unknown) => {
  seen.push({ url: String(url), init: (init ?? {}) as RequestInit })
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, notebooks: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

void api.tree()
ok(
  (seen[0]?.init.headers as Record<string, string> | undefined)?.['X-Zt-Token'] === 'tok-b',
  'apiGet 带上 X-Zt-Token',
  JSON.stringify(seen[0]?.init.headers),
)

// 存盘时清掉正文里的令牌：图片 src 渲染时会临时挂 ?t=，不能写进笔记
void api.saveDoc('box', 'doc', [
  { id: 'b1', type: 'paragraph', pm: { type: 'image', attrs: { src: 'assets/x.png?t=tok-b' } } },
  { id: 'b2', type: 'paragraph', pm: { type: 'link', text: 'https://example.com/?t=123&x=1' } },
] as unknown as import('../src/types').SaveBlock[])
const saveBody = String(seen[1]?.init.body ?? '')
ok(!saveBody.includes('tok-b'), '存盘请求里没有会话令牌', saveBody)
ok(saveBody.includes('assets/x.png'), '图片地址本身保留')
ok(saveBody.includes('https://example.com/?t=123&x=1'), '外链里同名的 t 参数不动')

// 没有令牌时不该带空头
clearToken()
ok(withToken('assets/x.png') === 'assets/x.png', '没有令牌时地址原样返回')
void api.tree()
const lastHdr = seen[seen.length - 1]?.init.headers as Record<string, string> | undefined
ok(lastHdr?.['X-Zt-Token'] === undefined, '没有令牌时不发 X-Zt-Token')

// localStorage 彻底不可用（隐私模式 / WebView 配额）：内存里那份仍要让本页可用
const blocked = {
  getItem: () => null,
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}
g.window = { localStorage: blocked }
clearToken()
saveToken('1000', 'tok-c')
ok(tokenValue() === 'tok-c', 'localStorage 存不下时仍留在内存里（本页继续可用）')
clearToken()
ok(tokenValue() === '', '清理后内存与 localStorage 都不留令牌')

console.log(`\n逻辑自测结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed ? 1 : 0)
