// 块模型逻辑自测（无浏览器、无后端）：
// 用真实的 TipTap schema 跑 sanitizeBlocks / planSave / isDirty，
// 校验「保持不变 → changed:false + 原 ID」「改动 → changed:true + 原 ID」
// 「新增 → id:null」「删除 → 不出现在下发列表」这四条与 docs/API.md 的约定。
//
// 运行：npm run test:logic
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { isDirty, planSave, sanitizeBlocks, stableStringify } from '../src/docjson'
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
  Image.configure({ inline: true, allowBase64: false }),
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
    // 编辑器不支持的表格：应降级为段落，但未改动时仍以原块 ID 交回后端（changed:false）
    id: 'b4',
    type: 'table',
    pm: {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'D' }] }] }] },
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
ok(s.content.length === 6, '6 个顶层节点（表格 2 行 → 2 个段落）', `实际 ${s.content.length}`)
ok(s.unsupportedBlocks === 1, '统计到 1 个不受支持的块（表格）', `实际 ${s.unsupportedBlocks}`)
ok(s.baseline[0].id === 'b1' && s.baseline[1].id === 'b2' && s.baseline[2].id === 'b3', '前 3 块 ID 保持 b1/b2/b3')
ok(s.baseline[3].id === 'b4' && s.baseline[4].id === '', '表格首段继承 b4，其余为新块（id 空）')
ok(s.content[3].type === 'paragraph' && s.content[3].content?.[0]?.text === 'A | B', '表格降级为「A | B」段落', JSON.stringify(s.content[3]))
const codeNode = s.content[2]
ok(codeNode.type === 'codeBlock' && codeNode.attrs?.language === 'go', '代码块语言 go 保留', JSON.stringify(codeNode.attrs))
const marked = s.content[5]
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
ok(untouched[3].id === 'b4' && untouched[3].changed === false, '表格首段 changed:false + b4（后端复用原 .sy 节点）')
ok(untouched[4].id === null && untouched[4].changed === true, '表格拆分出的第 2 段按新块下发（id:null）')

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
ok(removed.length === 5, '其余 5 块照常下发', `实际 ${removed.length}`)

console.log(`\n逻辑自测结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed ? 1 : 0)
