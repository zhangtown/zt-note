package siyuan

import (
	"encoding/json"
	"strings"
	"testing"
)

// syTable 造一个思源原生表格（结构同 Lute parse/table.go：表头行在 NodeTableHead 下，
// 单元格直接存行内节点，列宽记在表格的 colgroup 属性里，对齐记在 TableAligns/TableCellAlign）。
func syTable(id string) string {
	return `{
		"ID": "` + id + `",
		"Type": "NodeTable",
		"TableAligns": [0, 2],
		"Properties": {"id": "` + id + `", "colgroup": "width: 120px|width: 80px"},
		"Children": [
			{"Type": "NodeTableHead", "Children": [
				{"Type": "NodeTableRow", "Children": [
					{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": "名称"}]},
					{"Type": "NodeTableCell", "TableCellAlign": 2, "Children": [{"Type": "NodeText", "Data": "数量"}]}
				]}
			]},
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": "苹果"}]},
				{"Type": "NodeTableCell", "TableCellAlign": 2, "Children": [{"Type": "NodeText", "Data": "3"}]}
			]},
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": "合计"}]},
				{"Type": "NodeTableCell", "TableCellAlign": 2, "Children": [{"Type": "NodeText", "Data": "3"}]}
			]}
		]
	}`
}

// 读：.sy 表格要能进编辑器，而且表头行要用 tableHeader（别丢表头）。
func TestTableToPM(t *testing.T) {
	doc := mustParse(t, documentJSON([]string{syTable("20260927120000-tb00001")}))
	blocks := DocBlocks(doc)
	if len(blocks) != 1 {
		t.Fatalf("应该有 1 个块，实际 %d", len(blocks))
	}
	pm := string(blocks[0].PM)
	if !strings.Contains(pm, `"type":"table"`) {
		t.Fatalf("表格没有变成编辑器里的 table 节点：%s", pm)
	}
	if !strings.Contains(pm, `"type":"tableHeader"`) {
		t.Errorf("表头行应该用 tableHeader：%s", pm)
	}
	if got := strings.Count(pm, `"type":"tableRow"`); got != 3 {
		t.Errorf("应该有 3 行，实际 %d：%s", got, pm)
	}
	if got := strings.Count(pm, `"type":"tableCell"`); got != 4 {
		t.Errorf("应该只有 4 个非表头单元格，实际 %d：%s", got, pm)
	}
	if strings.Contains(pm, "NodeTableRow") || strings.Contains(pm, "苹果 | 3") {
		t.Errorf("表格不该降级成纯文本：%s", pm)
	}
}

// 未改动 → 原节点原样复用（字节级保真），改了才重建。
func TestTableRoundTrip(t *testing.T) {
	sy := documentJSON([]string{syTable("20260927120000-tb00001")})
	doc := mustParse(t, sy)
	blocks := DocBlocks(doc)
	baseline := string(mustParse(t, sy).Marshal())

	if ApplyBlocks(doc, []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: false}}) {
		t.Errorf("未改动的表格不该判定为已修改")
	}
	if got := string(doc.Marshal()); got != baseline {
		t.Errorf("未改动时表格应逐字节不变：\n%s\n---\n%s", got, baseline)
	}

	// 改了：重建为 .sy 表格，表头行回 NodeTableHead，列宽与对齐按位置搬回来
	doc2 := mustParse(t, sy)
	in := []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: true}}
	if !ApplyBlocks(doc2, in) {
		t.Fatalf("Changed:true 应判定为已修改")
	}
	table := doc2.Children[0]
	if table.Type != "NodeTable" {
		t.Fatalf("重建后应是表格，实际 %s", table.Type)
	}
	if v, _ := table.Props().Get("colgroup"); v != "width: 120px|width: 80px" {
		t.Errorf("colgroup 列宽丢了：%q", v)
	}
	if len(table.TableAligns) != 2 || table.TableAligns[1] != 2 {
		t.Errorf("TableAligns 丢了：%v", table.TableAligns)
	}
	if len(table.Children) != 3 || table.Children[0].Type != "NodeTableHead" {
		t.Fatalf("表头行应回到 NodeTableHead 下（共 3 个子节点）：%+v", table.Children)
	}
	headRow := table.Children[0].Children[0]
	if headRow.Type != "NodeTableRow" || len(headRow.Children) != 2 {
		t.Fatalf("表头行结构不对：%+v", headRow)
	}
	// 单元格直接存行内节点（思源原生形态），不要再套一层段落
	cell := table.Children[1].Children[1]
	if len(cell.Children) != 1 || cell.Children[0].Type != "NodeText" {
		t.Fatalf("单元格应直接存行内节点：%+v", cell.Children)
	}
	if cell.Children[0].Data != "3" {
		t.Errorf("单元格内容 = %q，期望 3", cell.Children[0].Data)
	}
	if cell.TableCellAlign != 2 {
		t.Errorf("单元格对齐丢了：%d", cell.TableCellAlign)
	}
	if _, ok := cell.Props().Get("id"); ok {
		t.Errorf("单元格不该写出 Properties：%v", cell.Props().Keys())
	}

	// 重建后的表格要能被再次读进编辑器（幂等）
	again := DocBlocks(doc2)
	if len(again) != 1 {
		t.Fatalf("重建后应有 1 个块，实际 %d", len(again))
	}
	if string(again[0].PM) != string(blocks[0].PM) {
		t.Errorf("重建后再次读出的编辑器数据不一致：\n%s\n%s", again[0].PM, blocks[0].PM)
	}
}

// 单元格合并（colspan/rowspan）要能进出编辑器。
func TestTableSpanRoundTrip(t *testing.T) {
	sy := documentJSON([]string{`{
		"ID": "20260927120000-tb00002",
		"Type": "NodeTable",
		"Children": [
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "Properties": {"colspan": "2"}, "Children": [{"Type": "NodeText", "Data": "跨两列"}]},
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": "普通"}]}
			]}
		]
	}`})
	doc := mustParse(t, sy)
	blocks := DocBlocks(doc)
	pm := string(blocks[0].PM)
	if !strings.Contains(pm, `"colspan":2`) {
		t.Fatalf("合并信息没进编辑器：%s", pm)
	}
	doc2 := mustParse(t, sy)
	ApplyBlocks(doc2, []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: true}})
	cell := doc2.Children[0].Children[0].Children[0]
	colspan, rowspan := cell.TableSpan()
	if colspan != 2 || rowspan != 1 {
		t.Errorf("合并信息丢了：colspan=%d rowspan=%d", colspan, rowspan)
	}
	if _, ok := cell.Props().Get("rowspan"); ok {
		t.Errorf("不该写出多余的 rowspan：%v", cell.Props().Keys())
	}
}

// 单元格富文本（思源 3.3+ 的多块单元格）编辑器表示不了：降级为纯文本，未编辑时原样保留。
func TestTableRichCellPreserved(t *testing.T) {
	sy := documentJSON([]string{`{
		"ID": "20260927120000-tb00003",
		"Type": "NodeTable",
		"Children": [
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "TableCellRich": {"spec": 1, "format": "kramdown", "content": "## 标题"},
				 "Children": [{"Type": "NodeText", "Data": "标题"}]}
			]}
		]
	}`})
	doc := mustParse(t, sy)
	blocks := DocBlocks(doc)
	baseline := string(mustParse(t, sy).Marshal())
	if !strings.Contains(string(blocks[0].PM), "标题") {
		t.Fatalf("富文本单元格应降级为可读文本：%s", blocks[0].PM)
	}
	if ApplyBlocks(doc, []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: false}}) {
		t.Errorf("未编辑的富文本单元格不该判定为已修改")
	}
	if got := string(doc.Marshal()); got != baseline {
		t.Errorf("未编辑时富文本单元格应逐字节保留：\n%s\n---\n%s", got, baseline)
	}
}

// 阅读视图：表头行渲染成 thead/th，合并与对齐带上属性。
func TestRenderTableHTML(t *testing.T) {
	doc := mustParse(t, documentJSON([]string{syTable("20260927120000-tb00001")}))
	h := RenderDocHTML(doc)
	for _, want := range []string{"<thead>", "<th>名称</th>", "<th style=\"text-align: center\">数量</th>", "<td>苹果</td>"} {
		if !strings.Contains(h, want) {
			t.Errorf("表格 HTML 缺少 %s：\n%s", want, h)
		}
	}

	doc2 := mustParse(t, documentJSON([]string{`{
		"ID": "20260927120000-tb00004",
		"Type": "NodeTable",
		"Children": [
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "Properties": {"colspan": "2", "rowspan": "3"}, "Children": [{"Type": "NodeText", "Data": "大格"}]},
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": "小"}]}
			]}
		]
	}`}))
	h2 := RenderDocHTML(doc2)
	if !strings.Contains(h2, `colspan="2"`) || !strings.Contains(h2, `rowspan="3"`) {
		t.Errorf("合并单元格应渲染 colspan/rowspan：\n%s", h2)
	}
}

// Markdown 导出：表头行 + 带对齐的分隔行；Markdown 导入：表头行进 NodeTableHead。
func TestTableMarkdownRoundTrip(t *testing.T) {
	doc := mustParse(t, documentJSON([]string{syTable("20260927120000-tb00001")}))
	md := RenderDocMarkdown(doc)
	for _, want := range []string{"| 名称 | 数量 |", "| --- | :---: |", "| 苹果 | 3 |"} {
		if !strings.Contains(md, want) {
			t.Errorf("Markdown 导出缺少 %q：\n%s", want, md)
		}
	}

	doc2 := MDToDoc(md, "表格", "20260927120000-tb00005")
	if len(doc2.Children) != 1 || doc2.Children[0].Type != "NodeTable" {
		t.Fatalf("Markdown 表格没导入成表格：%+v", doc2.Children)
	}
	table := doc2.Children[0]
	if len(table.Children) == 0 || table.Children[0].Type != "NodeTableHead" {
		t.Fatalf("Markdown 表头行应进 NodeTableHead：%+v", table.Children)
	}
	if len(table.TableAligns) != 2 || table.TableAligns[1] != 2 {
		t.Errorf("Markdown 对齐没解析出来：%v", table.TableAligns)
	}
	// 再导出一遍应该稳定（不重复表头行）
	md2 := RenderDocMarkdown(MDToDoc(md, "表格", "20260927120000-tb00006"))
	if md2 != md {
		t.Errorf("Markdown 表格往返不一致：\n%s\n---\n%s", md, md2)
	}
}

// 编辑器「插入表格 / 加行加列」都会走 PMToNodes，这里直接校验 PM 表格的还原。
func TestPMTableToNodes(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "table",
		"content": [
			{"type": "tableRow", "content": [
				{"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
				{"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]}
			]},
			{"type": "tableRow", "content": [
				{"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "1"}]}]},
				{"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "2"}]}]}
			]},
			{"type": "tableRow", "content": [
				{"type": "tableRow", "content": []}
			]}
		]
	}`)
	nodes := PMToNodes(raw)
	if len(nodes) != 1 || nodes[0].Type != "NodeTable" {
		t.Fatalf("应还原出一个表格：%+v", nodes)
	}
	table := nodes[0]
	if len(table.Children) != 2 || table.Children[0].Type != "NodeTableHead" {
		t.Fatalf("表头行结构不对：%+v", table.Children)
	}
	body := table.Children[1]
	if len(body.Children) != 2 {
		t.Fatalf("正文行应有 2 个单元格：%+v", body.Children)
	}
	if got := body.Children[0].Children; len(got) != 1 || got[0].Data != "1" {
		t.Errorf("单元格内容不对：%+v", got)
	}
	if TableColumns(table) != 2 {
		t.Errorf("列数 = %d，期望 2", TableColumns(table))
	}
}

// 表格里的空段落不应被当成空块丢掉（否则表格会变成空文档）。
func TestTableNotEmptyBlock(t *testing.T) {
	doc := mustParse(t, documentJSON([]string{`{
		"ID": "20260927120000-tb00007",
		"Type": "NodeTable",
		"Children": [
			{"Type": "NodeTableRow", "Children": [
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": ""}]},
				{"Type": "NodeTableCell", "Children": [{"Type": "NodeText", "Data": ""}]}
			]}
		]
	}`}))
	blocks := DocBlocks(doc)
	if len(blocks) != 1 {
		t.Fatalf("空表格也应有 1 个块，实际 %d", len(blocks))
	}
	if !ApplyBlocks(doc, []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: true}}) {
		t.Errorf("Changed:true 应判定为已修改")
	}
	if len(doc.Children) != 1 || doc.Children[0].Type != "NodeTable" {
		t.Fatalf("空表格重建后不该消失：%+v", doc.Children)
	}
	if TableColumns(doc.Children[0]) != 2 {
		t.Errorf("空表格重建后列数 = %d，期望 2", TableColumns(doc.Children[0]))
	}
}
