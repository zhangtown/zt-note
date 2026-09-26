// 表格扩展：思源 .sy 里的表格是 Lute 的 NodeTable / NodeTableHead / NodeTableRow / NodeTableCell，
// 后端把它们翻译成 ProseMirror 的 table / tableRow / tableHeader / tableCell
// （见 internal/siyuan/pm.go 的 tableToPM），这里把对应的 TipTap 扩展装上，
// 表格在编辑器里就是真表格（能加行删列、合并单元格），不再是降级段落。
//
// 单独一个模块是为了让 ui/scripts/logic-test.ts 也能用同一份 schema 跑回归。
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import type { Extensions } from '@tiptap/core'

export function tableExtensions(): Extensions {
  return [
    // 列宽不用鼠标拖拽改：宽度存在 .sy 的 colgroup 属性里，本版保留原值
    Table.configure({ resizable: false, allowTableNodeSelection: true }),
    TableRow,
    TableHeader,
    TableCell,
  ]
}
