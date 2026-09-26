package siyuan

import (
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- HTML

// RenderDocHTML 把一个 .sy 文档渲染为 HTML 片段。
func RenderDocHTML(doc *Node) string {
	if doc == nil {
		return ""
	}
	return RenderBlocksHTML(doc.Children)
}

// RenderBlocksHTML 渲染一组块级节点。
// 每个顶层块都在第一个标签上带 data-node-id（= .sy 里的块 ID），前端搜索结果定位
// （ui/src/views/doc.ts highlightBlock 用 [data-node-id=...] 查询）和导出的 HTML 都靠它。
func RenderBlocksHTML(blocks []*Node) string {
	var sb strings.Builder
	for i := 0; i < len(blocks); {
		// 连续的「图片行」段落（段内图片带 parent-style 宽度，思源里一行多图）
		// 包进一个容器，让它们横排成一行：段落用 inline-block + 百分比宽度时，
		// 块与块之间的空白字符会自己占一个空格宽，四张 25% 的图正好会被挤到下一行，
		// 所以容器内部一个空白字符都不能留（块自身的尾随换行也要去掉）。
		if rowWidth(blocks[i]) != "" {
			j := i
			var rows strings.Builder
			for j < len(blocks) && rowWidth(blocks[j]) != "" {
				rows.WriteString(strings.TrimRight(withNodeID(blocks[j].ID, RenderBlockHTML(blocks[j])), "\n"))
				j++
			}
			if j-i > 1 {
				sb.WriteString(`<div class="img-rows">` + rows.String() + "</div>\n")
				i = j
				continue
			}
		}
		sb.WriteString(withNodeID(blocks[i].ID, RenderBlockHTML(blocks[i])))
		i++
	}
	return sb.String()
}

// rowWidth 返回段落作为「图片行」单元格时的宽度（来自段内图片的 parent-style），
// 非图片行返回空串。
func rowWidth(n *Node) string {
	if n == nil || n.Type != "NodeParagraph" {
		return ""
	}
	return imageRowWidth(n)
}

// withNodeID 把 data-node-id 注入到一段块 HTML 的首个开始标签里。
// 块 ID 一定是安全的十六进制-破折号串，但仍旧转义，避免以后格式变化引入注入。
func withNodeID(id, blockHTML string) string {
	if id == "" || blockHTML == "" {
		return blockHTML
	}
	lt := strings.IndexByte(blockHTML, '<')
	if lt < 0 {
		return blockHTML
	}
	gt := strings.IndexByte(blockHTML[lt:], '>')
	if gt < 0 {
		return blockHTML
	}
	gt += lt
	return blockHTML[:gt] + ` data-node-id="` + html.EscapeString(id) + `"` + blockHTML[gt:]
}

// RenderBlockHTML 渲染单个块级节点。
func RenderBlockHTML(n *Node) string {
	if n == nil {
		return ""
	}
	switch n.Type {
	case "NodeParagraph":
		inner := RenderInlineHTML(n.Children)
		if strings.TrimSpace(inner) == "" {
			return ""
		}
		// 图片行：思源把“一行几张”记在图片节点的 parent-style 上（如 width: 25%），
		// 渲染时应用到包裹它的段落——四张 25% 的图就会横排成一行，跟思源里一样。
		if w := imageRowWidth(n); w != "" {
			return `<p class="img-row" style="width:` + html.EscapeString(w) + `">` + inner + "</p>\n"
		}
		return "<p>" + inner + "</p>\n"

	case "NodeHeading":
		level := n.HeadingLevel
		if level < 1 || level > 6 {
			level = 1
		}
		id := n.ID
		return fmt.Sprintf("<h%d id=\"%s\">%s</h%d>\n", level, html.EscapeString(id), RenderInlineHTML(n.Children), level)

	case "NodeCodeBlock":
		lang := html.EscapeString(n.Lang())
		cls := ""
		if lang != "" {
			cls = fmt.Sprintf(" class=\"language-%s\"", lang)
		}
		code := html.EscapeString(n.CodeBlockCode())
		return fmt.Sprintf("<pre><code%s>%s</code></pre>\n", cls, code)

	case "NodeBlockquote":
		var sb strings.Builder
		sb.WriteString("<blockquote>\n")
		for _, c := range n.Children {
			if c.Type == "NodeBlockquoteMarker" {
				continue
			}
			if c.IsInline() {
				// 罕见：引用里的裸行内节点
				sb.WriteString("<p>" + RenderInlineHTML([]*Node{c}) + "</p>\n")
				continue
			}
			sb.WriteString(RenderBlockHTML(c))
		}
		sb.WriteString("</blockquote>\n")
		return sb.String()

	case "NodeList":
		var sb strings.Builder
		sb.WriteString("<ul>\n")
		for _, c := range n.Children {
			sb.WriteString(renderListItem(c, false))
		}
		sb.WriteString("</ul>\n")
		return sb.String()

	case "NodeOrderedList":
		start := strings.TrimSpace(n.Prop("start"))
		attr := ""
		if start != "" && start != "1" {
			attr = fmt.Sprintf(" start=\"%s\"", html.EscapeString(start))
		}
		var sb strings.Builder
		sb.WriteString("<ol" + attr + ">\n")
		for _, c := range n.Children {
			sb.WriteString(renderListItem(c, true))
		}
		sb.WriteString("</ol>\n")
		return sb.String()

	case "NodeThematicBreak":
		return "<hr>\n"

	case "NodeTable":
		return renderTable(n)

	case "NodeHTMLBlock":
		return n.CodeBlockCode() + "\n"

	case "NodeMathBlock":
		return "<div class=\"math-block\">" + html.EscapeString(n.CodeBlockCode()) + "</div>\n"

	default:
		if n.IsInline() {
			s := RenderInlineHTML([]*Node{n})
			if strings.TrimSpace(s) == "" {
				return ""
			}
			return "<p>" + s + "</p>\n"
		}
		// 未知块：尽力渲染子节点
		if len(n.Children) > 0 {
			var sb strings.Builder
			for _, c := range n.Children {
				sb.WriteString(RenderBlockHTML(c))
			}
			return sb.String()
		}
		return ""
	}
}

func renderListItem(item *Node, ordered bool) string {
	var sb strings.Builder
	sb.WriteString("<li>")
	// 连续的行内节点合并为一个段落
	var inlineRun []*Node
	flushInline := func() {
		if len(inlineRun) == 0 {
			return
		}
		sb.WriteString("<p>" + RenderInlineHTML(inlineRun) + "</p>")
		inlineRun = nil
	}
	var blocks []*Node
	for _, c := range item.Children {
		if c.IsInline() && c.Type != "NodeImage" {
			inlineRun = append(inlineRun, c)
			continue
		}
		flushInline()
		blocks = append(blocks, c)
	}
	flushInline()
	for _, b := range blocks {
		sb.WriteString(RenderBlockHTML(b))
	}
	sb.WriteString("</li>\n")
	return sb.String()
}

func renderTable(table *Node) string {
	var sb strings.Builder
	sb.WriteString("<table>\n")
	for _, child := range table.Children {
		switch child.Type {
		case "NodeTableHead":
			// 思源把表头行放在 NodeTableHead 里（见 Lute parse/table.go）
			sb.WriteString("<thead>\n")
			for _, row := range child.Children {
				sb.WriteString(renderTableRow(row, "th"))
			}
			sb.WriteString("</thead>\n")
		case "NodeTableRow":
			sb.WriteString(renderTableRow(child, "td"))
		}
	}
	sb.WriteString("</table>\n")
	return sb.String()
}

func renderTableRow(row *Node, cellTag string) string {
	if row.Type != "NodeTableRow" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("<tr>")
	for _, cell := range row.Children {
		if cell.Type != "NodeTableCell" {
			continue
		}
		attrs := ""
		if colspan, rowspan := cell.TableSpan(); colspan > 1 || rowspan > 1 {
			if colspan > 1 {
				attrs += fmt.Sprintf(" colspan=\"%d\"", colspan)
			}
			if rowspan > 1 {
				attrs += fmt.Sprintf(" rowspan=\"%d\"", rowspan)
			}
		}
		if style := tableCellAlignStyle(cell.TableCellAlign); style != "" {
			attrs += " style=\"" + style + "\""
		}
		sb.WriteString("<" + cellTag + attrs + ">" + cellHTML(cell) + "</" + cellTag + ">")
	}
	sb.WriteString("</tr>\n")
	return sb.String()
}

// cellHTML 渲染单元格内容：思源原生的单元格直接存行内节点（渲染成 `<td>文字</td>`，
// 不要再套 `<p>`——单元格里的段落间距很丑），早期 Markdown 导入的会包一层段落；
// 两种都要能渲染。
func cellHTML(cell *Node) string {
	children := cell.Children
	if allInline(children) {
		return RenderInlineHTML(children)
	}
	if len(children) == 1 && children[0].Type == "NodeParagraph" {
		inner := RenderInlineHTML(children[0].Children)
		if strings.TrimSpace(inner) == "" {
			return ""
		}
		return inner
	}
	var sb strings.Builder
	for i := 0; i < len(children); {
		if children[i].IsInline() {
			j := i
			var run []*Node
			for j < len(children) && children[j].IsInline() {
				run = append(run, children[j])
				j++
			}
			sb.WriteString(RenderInlineHTML(run))
			i = j
			continue
		}
		sb.WriteString(RenderBlockHTML(children[i]))
		i++
	}
	return sb.String()
}

func allInline(nodes []*Node) bool {
	for _, n := range nodes {
		if !n.IsInline() {
			return false
		}
	}
	return true
}

// tableCellAlignStyle 把思源的对齐编码（0 默认、1 左、2 中、3 右）变成行内样式，与 Lute 渲染一致。
func tableCellAlignStyle(align int) string {
	switch align {
	case 1:
		return "text-align: left"
	case 2:
		return "text-align: center"
	case 3:
		return "text-align: right"
	}
	return ""
}

var zeroWidthRe = regexp.MustCompile("[\u200b\u200c\u200d]")

// RenderInlineHTML 渲染行内节点序列。
func RenderInlineHTML(nodes []*Node) string {
	var sb strings.Builder
	for _, n := range nodes {
		sb.WriteString(renderInlineNode(n))
	}
	return zeroWidthRe.ReplaceAllString(sb.String(), "")
}

func renderInlineNode(n *Node) string {
	if n == nil {
		return ""
	}
	switch n.Type {
	case "NodeText":
		return html.EscapeString(n.Data)
	case "NodeSoftBreak", "NodeHardBreak":
		return "<br>\n"
	case "NodeBackslash":
		return "\\"
	case "NodeOpenParen", "NodeCloseParen", "NodeOpenBracket", "NodeCloseBracket", "NodeBang":
		return html.EscapeString(n.Data)
	case "NodeKramdownSpanIAL":
		return ""
	case "NodeTextMark":
		content := html.EscapeString(n.TextContent)
		for _, t := range strings.Fields(n.TextMark) {
			switch t {
			case "strong":
				content = "<strong>" + content + "</strong>"
			case "em":
				content = "<em>" + content + "</em>"
			case "code":
				content = "<code>" + content + "</code>"
			case "a":
				href := html.EscapeString(n.TextHref)
				content = fmt.Sprintf("<a href=\"%s\" target=\"_blank\" rel=\"noopener\">%s</a>", href, content)
			case "mark":
				content = "<mark>" + content + "</mark>"
			case "s":
				content = "<s>" + content + "</s>"
			case "u":
				content = "<u>" + content + "</u>"
			case "kbd":
				content = "<kbd>" + content + "</kbd>"
			case "sub":
				content = "<sub>" + content + "</sub>"
			case "sup":
				content = "<sup>" + content + "</sup>"
			case "tag":
				content = "<span class=\"tag\">" + content + "</span>"
			case "inline-math":
				content = "<span class=\"math-inline\">" + content + "</span>"
			}
		}
		return content
	case "NodeImage":
		alt, src := imageParts(n)
		return fmt.Sprintf("<img src=\"%s\" alt=\"%s\" loading=\"lazy\"%s>", html.EscapeString(src), html.EscapeString(alt), imageSizeAttr(n))
	case "NodeLink":
		text, href := linkParts(n)
		return fmt.Sprintf("<a href=\"%s\" target=\"_blank\" rel=\"noopener\">%s</a>", html.EscapeString(href), html.EscapeString(text))
	case "NodeLinkText", "NodeLinkDest":
		return html.EscapeString(n.Data)
	default:
		if len(n.Children) > 0 {
			var sb strings.Builder
			for _, c := range n.Children {
				sb.WriteString(renderInlineNode(c))
			}
			return sb.String()
		}
		return html.EscapeString(n.Data)
	}
}

// imageParts 从 NodeImage 的 markup 子节点里取出 alt 与 src。
func imageParts(n *Node) (alt, src string) {
	for _, c := range n.Children {
		switch c.Type {
		case "NodeLinkText":
			alt += c.Data
		case "NodeLinkDest":
			src = c.Data
		}
	}
	if src == "" {
		src = n.Data
	}
	return alt, src
}

// cssWidth 从思源的 style 片段里取出宽度值（"width: 25%;" → "25%"）。
// 只接受「数字 + px|%」形式，其余一律忽略：.sy 是用户文件，不能让任意文本
// 直接进 HTML 属性（虽然最终还会被 html.EscapeString 转义，双重保险）。
func cssWidth(style string) string {
	for _, part := range strings.Split(style, ";") {
		k, v, ok := strings.Cut(part, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), "width") {
			continue
		}
		v = strings.TrimSpace(v)
		num, unit := v, ""
		switch {
		case strings.HasSuffix(v, "%"):
			unit, num = "%", strings.TrimSuffix(v, "%")
		case strings.HasSuffix(strings.ToLower(v), "px"):
			unit, num = "px", v[:len(v)-2]
		default:
			continue
		}
		sharp := strings.TrimSpace(num)
		if sharp == "" {
			continue
		}
		if _, err := strconv.ParseFloat(sharp, 64); err != nil {
			continue
		}
		return sharp + unit
	}
	return ""
}

// imageRowWidth 返回段落里图片要占的宽度：思源把「一行几张」记在图片节点的
// parent-style 上（四张 25% 的图就是一行），渲染时应用到包着它的段落上。
func imageRowWidth(n *Node) string {
	for _, c := range n.Children {
		if c == nil || c.Type != "NodeImage" {
			continue
		}
		if w := cssWidth(c.Prop("parent-style")); w != "" {
			return w
		}
	}
	return ""
}

// imageSizeAttr 把思源图片节点的 style 宽度转成 img 的内联样式。
// 思源用很大的 width（如 10000px）表示原始尺寸，靠 max-width:100% 收进容器。
func imageSizeAttr(n *Node) string {
	w := cssWidth(n.Prop("style"))
	if w == "" {
		return ""
	}
	return ` style="width:` + w + `;max-width:100%;height:auto"`
}

func linkParts(n *Node) (text, href string) {
	for _, c := range n.Children {
		switch c.Type {
		case "NodeLinkText":
			text += c.Data
		case "NodeLinkDest":
			href = c.Data
		}
	}
	return text, href
}

// ---------------------------------------------------------------- Markdown

// RenderDocMarkdown 把文档渲染为 Markdown（用于导出）。
func RenderDocMarkdown(doc *Node) string {
	var sb strings.Builder
	renderBlocksMD(&sb, doc.Children, 0)
	return strings.TrimRight(sb.String(), "\n") + "\n"
}

func renderBlocksMD(sb *strings.Builder, blocks []*Node, indent int) {
	for _, b := range blocks {
		renderBlockMD(sb, b, indent)
	}
}

func renderBlockMD(sb *strings.Builder, n *Node, indent int) {
	if n == nil {
		return
	}
	pad := strings.Repeat("  ", indent)
	switch n.Type {
	case "NodeParagraph":
		t := RenderInlineMD(n.Children)
		if strings.TrimSpace(t) == "" {
			return
		}
		sb.WriteString(pad + t + "\n\n")

	case "NodeHeading":
		level := n.HeadingLevel
		if level < 1 || level > 6 {
			level = 1
		}
		sb.WriteString(pad + strings.Repeat("#", level) + " " + RenderInlineMD(n.Children) + "\n\n")

	case "NodeCodeBlock":
		lang := n.Lang()
		sb.WriteString(pad + "```" + lang + "\n" + n.CodeBlockCode() + "\n" + pad + "```\n\n")

	case "NodeBlockquote":
		var inner strings.Builder
		for _, c := range n.Children {
			if c.Type == "NodeBlockquoteMarker" {
				continue
			}
			renderBlockMD(&inner, c, 0)
		}
		for _, line := range strings.Split(strings.TrimRight(inner.String(), "\n"), "\n") {
			sb.WriteString(pad + "> " + line + "\n")
		}
		sb.WriteString("\n")

	case "NodeList", "NodeOrderedList":
		ordered := n.Type == "NodeOrderedList"
		i := 1
		for _, item := range n.Children {
			if item.Type != "NodeListItem" {
				continue
			}
			marker := "- "
			if ordered {
				marker = fmt.Sprintf("%d. ", i)
				i++
			}
			var inner strings.Builder
			for _, c := range item.Children {
				if c.IsInline() && c.Type != "NodeImage" {
					continue
				}
				if c.IsInline() {
					inner.WriteString(RenderInlineMD([]*Node{c}) + "\n")
					continue
				}
				renderBlockMD(&inner, c, 0)
			}
			lines := strings.Split(strings.TrimRight(inner.String(), "\n"), "\n")
			for j, line := range lines {
				if j == 0 {
					sb.WriteString(pad + marker + line + "\n")
				} else {
					sb.WriteString(pad + strings.Repeat(" ", len(marker)) + line + "\n")
				}
			}
		}
		sb.WriteString("\n")

	case "NodeThematicBreak":
		sb.WriteString(pad + "---\n\n")

	case "NodeTable":
		// NodeTableHead 里的行先渲染（思源把表头行放在那儿）
		rows := [][]string{}
		for _, row := range TableRows(n) {
			var cells []string
			for _, cell := range row.Children {
				if cell.Type != "NodeTableCell" {
					continue
				}
				var cs strings.Builder
				renderBlocksMD(&cs, cell.Children, 0)
				cells = append(cells, strings.ReplaceAll(strings.TrimSpace(cs.String()), "\n", " "))
			}
			rows = append(rows, cells)
		}
		if len(rows) > 0 {
			width := 0
			for _, r := range rows {
				if len(r) > width {
					width = len(r)
				}
			}
			for i, r := range rows {
				for len(r) < width {
					r = append(r, "")
				}
				sb.WriteString(pad + "| " + strings.Join(r, " | ") + " |\n")
				if i == 0 {
					sep := make([]string, width)
					for j := range sep {
						switch tableAlignAt(n, j) {
						case 1:
							sep[j] = ":---"
						case 2:
							sep[j] = ":---:"
						case 3:
							sep[j] = "---:"
						default:
							sep[j] = "---"
						}
					}
					sb.WriteString(pad + "| " + strings.Join(sep, " | ") + " |\n")
				}
			}
			sb.WriteString("\n")
		}

	default:
		if n.IsInline() {
			sb.WriteString(pad + RenderInlineMD([]*Node{n}) + "\n\n")
			return
		}
		renderBlocksMD(sb, n.Children, indent)
	}
}

// tableAlignAt 取第 i 列的对齐编码：优先用表格的 TableAligns，其次用该列单元格的 TableCellAlign。
func tableAlignAt(table *Node, i int) int {
	if i < len(table.TableAligns) {
		return table.TableAligns[i]
	}
	for _, row := range TableRows(table) {
		if i < len(row.Children) {
			return row.Children[i].TableCellAlign
		}
	}
	return 0
}

// RenderInlineMD 渲染行内节点为 Markdown。
func RenderInlineMD(nodes []*Node) string {
	var sb strings.Builder
	for _, n := range nodes {
		sb.WriteString(renderInlineMDNode(n))
	}
	return zeroWidthRe.ReplaceAllString(sb.String(), "")
}

func renderInlineMDNode(n *Node) string {
	if n == nil {
		return ""
	}
	switch n.Type {
	case "NodeText":
		return n.Data
	case "NodeSoftBreak":
		return "\n"
	case "NodeBackslash":
		return "\\"
	case "NodeKramdownSpanIAL":
		return ""
	case "NodeTextMark":
		c := n.TextContent
		for _, t := range strings.Fields(n.TextMark) {
			switch t {
			case "strong":
				c = "**" + c + "**"
			case "em":
				c = "*" + c + "*"
			case "code":
				c = "`" + c + "`"
			case "a":
				c = "[" + c + "](" + n.TextHref + ")"
			case "mark":
				c = "==" + c + "=="
			case "s":
				c = "~~" + c + "~~"
			case "u":
				c = "<u>" + c + "</u>"
			case "kbd":
				c = "<kbd>" + c + "</kbd>"
			case "sub":
				c = "<sub>" + c + "</sub>"
			case "sup":
				c = "<sup>" + c + "</sup>"
			case "tag":
				c = "#" + strings.Trim(c, "#") + "#"
			case "inline-math":
				c = "$" + c + "$"
			}
		}
		return c
	case "NodeImage":
		alt, src := imageParts(n)
		return "![" + alt + "](" + src + ")"
	case "NodeLink":
		text, href := linkParts(n)
		return "[" + text + "](" + href + ")"
	case "NodeLinkText", "NodeLinkDest":
		return n.Data
	default:
		if len(n.Children) > 0 {
			var sb strings.Builder
			for _, c := range n.Children {
				sb.WriteString(renderInlineMDNode(c))
			}
			return sb.String()
		}
		return n.Data
	}
}
