package siyuan

import (
	"fmt"
	"html"
	"regexp"
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
	for _, b := range blocks {
		sb.WriteString(withNodeID(b.ID, RenderBlockHTML(b)))
	}
	return sb.String()
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
	for _, row := range table.Children {
		if row.Type != "NodeTableRow" {
			continue
		}
		sb.WriteString("<tr>")
		for _, cell := range row.Children {
			if cell.Type != "NodeTableCell" {
				continue
			}
			sb.WriteString("<td>" + RenderBlocksHTML(cell.Children) + "</td>")
		}
		sb.WriteString("</tr>\n")
	}
	sb.WriteString("</table>\n")
	return sb.String()
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
		return fmt.Sprintf("<img src=\"%s\" alt=\"%s\" loading=\"lazy\">", html.EscapeString(src), html.EscapeString(alt))
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
		rows := [][]string{}
		for _, row := range n.Children {
			if row.Type != "NodeTableRow" {
				continue
			}
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
						sep[j] = "---"
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
