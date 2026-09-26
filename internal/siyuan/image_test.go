package siyuan

import (
	"strings"
	"testing"
)

// 思源把图片的排版信息记在图片节点自身的 Properties 上：
//
//	parent-style: 这一张占父块（段落）宽度的多少 —— 四张 "width: 25%;" 就是一行四张
//	style:        图片自身宽度（"width: 10000px;" 表示原始尺寸，靠 max-width:100% 收进容器）
//
// 这两条必须一起保真：读的时候要能渲染出「一行多图」，写回去的时候不能把属性弄丢。
func TestRenderImageLayout(t *testing.T) {
	// 四张 25% 的图（连续段落）+ 一段正文 + 一张只带 style 的图
	onlyStyle := `{"ID": "p6", "Type": "NodeParagraph", "Properties": {"id": "p6"}, "Children": [` +
		`{"Type": "NodeImage", "Data": "span", "Properties": {"style": "width: 3000px;"}, "Children": [` +
		`{"Type": "NodeBang"}, {"Type": "NodeOpenBracket"},` +
		`{"Type": "NodeLinkText", "Data": "大图"}, {"Type": "NodeCloseBracket"},` +
		`{"Type": "NodeOpenParen"}, {"Type": "NodeLinkDest", "Data": "assets/大图.png"}, {"Type": "NodeCloseParen"}` +
		`]}]}`
	rows := []string{
		imageParagraph("p1", "1月", "assets/一月.png", "width: 25%;"),
		imageParagraph("p2", "2月", "assets/二月.png", "width: 25%;"),
		imageParagraph("p3", "3月", "assets/三月.png", "width: 25%;"),
		imageParagraph("p4", "4月", "assets/四月.png", "width: 25%;"),
		`{"ID": "p5", "Type": "NodeParagraph", "Properties": {"id": "p5"}, "Children": [{"Type": "NodeText", "Data": "正文段落"}]}`,
		onlyStyle,
	}
	doc := mustParse(t, documentJSON(rows))

	html := RenderDocHTML(doc)

	// 连续四张 25% 的图片行包进 flex 容器（否则块间空白会把第 4 张挤到下一行）
	if !strings.Contains(html, `<div class="img-rows">`) {
		t.Errorf("连续的图片行应包进 .img-rows 容器，实际：\n%s", html)
	}
	if got := strings.Count(html, `<p class="img-row" style="width:25%"`); got != 4 {
		t.Errorf("应该有 4 个 width:25%% 的图片行段落，实际 %d 个\n%s", got, html)
	}
	// 每张图都是「原始宽度 + max-width:100%」，被段落宽度收住
	if !strings.Contains(html, `<img src="assets/一月.png" alt="1月" loading="lazy" style="width:10000px;max-width:100%;height:auto">`) {
		t.Errorf("图片应带思源的原始宽度与 max-width，实际：\n%s", html)
	}
	if !strings.Contains(html, `<img src="assets/大图.png" alt="大图" loading="lazy" style="width:3000px;max-width:100%;height:auto">`) {
		t.Errorf("只有 style 的图片也要带宽度，实际：\n%s", html)
	}
	// 容器内不能留空白：inline-block 之间哪怕一个空格，也会把第 4 张 25% 的图顶到下一行
	if i := strings.Index(html, `<div class="img-rows">`); i >= 0 {
		rest := html[i+len(`<div class="img-rows">`):]
		inner := rest[:strings.Index(rest, "</div>")]
		for _, gap := range []string{"</p>\n<p", "</p> <p", "</p>\t<p", "</p>\r\n<p"} {
			if strings.Contains(inner, gap) {
				t.Errorf("img-rows 容器里出现块间空白（%q），四张 25%% 的图会被拆行：\n%s", gap, inner)
			}
		}
	}
	// 块级定位（搜索跳转/导出）靠 data-node-id
	for _, id := range []string{"p1", "p2", "p3", "p4", "p6"} {
		if !strings.Contains(html, `data-node-id="`+id+`"`) {
			t.Errorf("块 %s 缺少 data-node-id：\n%s", id, html)
		}
	}
	// 正文段落不能被卷进图片行容器
	if got := strings.Count(html, `class="img-rows"`); got != 1 {
		t.Errorf("只应有一个 .img-rows 容器，实际 %d 个\n%s", got, html)
	}
	if strings.Contains(html, `<p class="img-row"`) && strings.Contains(html, `data-node-id="p5"`) {
		if strings.Contains(html, `<p class="img-row" style="width:25%" data-node-id="p5">`) {
			t.Errorf("正文段落不该被标成图片行：\n%s", html)
		}
	}
}

// cssWidth 只认「数字 + px|%」，其余一律忽略（.sy 是用户文件，不能把任意文本塞进 HTML 属性）。
func TestCSSWidth(t *testing.T) {
	cases := []struct{ in, want string }{
		{"width: 25%;", "25%"},
		{"width:25%;", "25%"},
		{"width: 10000px;", "10000px"},
		{"width: 3000PX;", "3000px"},
		{"text-align: center; width: 50%;", "50%"},
		{"width: auto;", ""},
		{"width: 50vh;", ""},
		{"width: abc;", ""},
		{"width: ;", ""},
		{"", ""},
		{`width: 25%;"><script>alert(1)</script>`, "25%"},
	}
	for _, c := range cases {
		if got := cssWidth(c.in); got != c.want {
			t.Errorf("cssWidth(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// 读（.sy → 编辑器）要带上排版属性；写回（编辑器 → .sy）不能丢，也不能多出空属性。
func TestImageLayoutRoundTrip(t *testing.T) {
	sy := documentJSON([]string{imageParagraph("p1", "一月", "assets/一月.png", "width: 25%;")})
	doc := mustParse(t, sy)

	blocks := DocBlocks(doc)
	if len(blocks) != 1 {
		t.Fatalf("应该有 1 个块，实际 %d", len(blocks))
	}
	pm := string(blocks[0].PM)
	for _, want := range []string{`"parentStyle":"width: 25%;"`, `"style":"width: 10000px;"`, `"src":"assets/一月.png"`, `"alt":"一月"`} {
		if !strings.Contains(pm, want) {
			t.Errorf("编辑器数据缺少 %s：%s", want, pm)
		}
	}

	// 没改动 → 原节点原样复用（字节级保真，不再重建图片）
	in := []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: false}}
	if ApplyBlocks(doc, in) {
		t.Errorf("未改动的文档不该判定为已修改")
	}
	if len(doc.Children) != 1 || doc.Children[0].ID != "p1" {
		t.Fatalf("未改动时应复用原节点，实际 %d 个块", len(doc.Children))
	}

	// 改了（Changed:true）→ 重建，但 parent-style/style 要跟着走
	doc2 := mustParse(t, sy)
	in2 := []BlockIn{{ID: blocks[0].ID, Type: blocks[0].Type, PM: blocks[0].PM, Changed: true}}
	if !ApplyBlocks(doc2, in2) {
		t.Errorf("Changed:true 应判定为已修改")
	}
	if len(doc2.Children) != 1 {
		t.Fatalf("重建后应仍有 1 个块，实际 %d", len(doc2.Children))
	}
	para := doc2.Children[0]
	var img *Node
	for _, c := range para.Children {
		if c.Type == "NodeImage" {
			img = c
		}
	}
	if img == nil {
		t.Fatalf("重建后的段落里没有图片节点")
	}
	if got := img.Prop("parent-style"); got != "width: 25%;" {
		t.Errorf("重建后 parent-style = %q，期望 width: 25%%", got)
	}
	if got := img.Prop("style"); got != "width: 10000px;" {
		t.Errorf("重建后 style = %q，期望 width: 10000px;", got)
	}
	if _, ok := img.Props().Get("id"); ok {
		t.Errorf("图片节点不该写出空的 id 属性：%v", img.Props().Keys())
	}
	if img.ID != "" {
		t.Errorf("行内图片不是独立块，不该有块 ID，实际 %q", img.ID)
	}
}

func mustParse(t *testing.T, sy string) *Node {
	t.Helper()
	doc, err := Parse([]byte(sy))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return doc
}

// documentJSON 把一组块 JSON 拼成一个 .sy 文档。
func documentJSON(children []string) string {
	return `{
		"ID": "20250604143405-29orui7",
		"Type": "NodeDocument",
		"Properties": {"id": "20250604143405-29orui7", "title": "示例文稿", "type": "doc"},
		"Children": [` + strings.Join(children, ",") + `]
	}`
}

// imageParagraph 造一个「一段文字 + 一张图」的段落，图片带思源排版属性。
func imageParagraph(id, label, src, parentStyle string) string {
	return `{"ID": "` + id + `", "Type": "NodeParagraph", "Properties": {"id": "` + id + `"}, "Children": [` +
		`{"Type": "NodeText", "Data": "` + label + `"},` +
		syImageNode(label, src, parentStyle) +
		`]}`
}

func syImageNode(alt, src, parentStyle string) string {
	return `{"Type": "NodeImage", "Data": "span", "Properties": {"parent-style": "` + parentStyle + `", "style": "width: 10000px;"}, "Children": [` +
		`{"Type": "NodeBang"}, {"Type": "NodeOpenBracket"},` +
		`{"Type": "NodeLinkText", "Data": "` + alt + `"}, {"Type": "NodeCloseBracket"},` +
		`{"Type": "NodeOpenParen"}, {"Type": "NodeLinkDest", "Data": "` + src + `"}, {"Type": "NodeCloseParen"}` +
		`]}`
}
