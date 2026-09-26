package siyuan

import (
	"regexp"
	"strings"
)

var (
	reHeading  = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	reFence    = regexp.MustCompile("^\\s*```(.*)$")
	reUL       = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	reOL       = regexp.MustCompile(`^(\s*)\d+[.)]\s+(.*)$`)
	reHR       = regexp.MustCompile(`^\s*(?:-{3,}|\*{3,}|_{3,})\s*$`)
	reComment  = regexp.MustCompile(`<!--\s*(?:最后更新|updated)\s*:?\s*(\d{14})\s*-->`)
	reTableSep = regexp.MustCompile(`^\s*\|[\s:|-]+\|\s*$`)
)

// NewDoc 创建一篇空文档。
func NewDoc(id, title string) *Node {
	if id == "" {
		id = NewID()
	}
	if strings.TrimSpace(title) == "" {
		title = "未命名文档"
	}
	doc := &Node{Type: "NodeDocument", ID: id, Spec: "1", props: NewProps()}
	doc.SetProp("id", id)
	doc.SetProp("title", title)
	doc.SetProp("type", "doc")
	doc.SetProp("updated", NowStamp())
	doc.Children = []*Node{}
	return doc
}

// DocTitle 返回文档标题。
func DocTitle(doc *Node) string {
	if doc == nil {
		return ""
	}
	if t := doc.Prop("title"); t != "" {
		return t
	}
	return doc.ID
}

// Updated 返回文档最后更新时间戳（yyyyMMddHHmmss）。
func Updated(doc *Node) string { return doc.Prop("updated") }

// MDToDoc 把 Markdown 文本解析为一篇思源文档。
func MDToDoc(md, title, docID string) *Node {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	doc := NewDoc(docID, title)
	for _, b := range parseMDBlocks(strings.Split(md, "\n")) {
		doc.Children = append(doc.Children, b)
	}
	if m := reComment.FindStringSubmatch(md); m != nil {
		doc.SetProp("updated", m[1])
	}
	return doc
}

// ---------------------------------------------------------------- 块解析

func parseMDBlocks(lines []string) []*Node {
	out := []*Node{}
	i := 0
	for i < len(lines) {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			i++
			continue
		}
		// 代码围栏
		if m := reFence.FindStringSubmatch(line); m != nil {
			lang := strings.TrimSpace(m[1])
			i++
			var code []string
			for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
				code = append(code, lines[i])
				i++
			}
			if i < len(lines) {
				i++ // 跳过结束围栏
			}
			out = append(out, CodeBlockNode(lang, strings.Join(code, "\n")))
			continue
		}
		// 分隔线
		if reHR.MatchString(line) {
			out = append(out, NewBlock("NodeThematicBreak", NewID()))
			i++
			continue
		}
		// 标题
		if m := reHeading.FindStringSubmatch(trimmed); m != nil {
			n := NewBlock("NodeHeading", NewID())
			n.HeadingLevel = len(m[1])
			n.hasHeadingLevel = true
			n.Children = ParseInline(strings.TrimSpace(m[2]))
			out = append(out, n)
			i++
			continue
		}
		// 引用
		if strings.HasPrefix(trimmed, ">") {
			var q []string
			for i < len(lines) {
				t := strings.TrimSpace(lines[i])
				if !strings.HasPrefix(t, ">") {
					break
				}
				q = append(q, strings.TrimSpace(strings.TrimPrefix(t, ">")))
				i++
			}
			n := NewBlock("NodeBlockquote", NewID())
			n.AppendNode(NewInline("NodeBlockquoteMarker", ">"))
			for _, b := range parseMDBlocks(q) {
				n.AppendNode(b)
			}
			out = append(out, n)
			continue
		}
		// 列表
		if reUL.MatchString(line) || reOL.MatchString(line) {
			n, next := parseMDList(lines, i)
			out = append(out, n)
			i = next
			continue
		}
		// 表格
		if strings.HasPrefix(trimmed, "|") {
			n, next := parseMDTable(lines, i)
			if n != nil {
				out = append(out, n)
			}
			i = next
			continue
		}
		// 段落
		var para []string
		for i < len(lines) {
			t := strings.TrimSpace(lines[i])
			if strings.HasPrefix(t, "<!--") {
				if strings.Contains(t, "-->") {
					i++
					continue
				}
				// 多行注释：一直跳到结束
				for i < len(lines) && !strings.Contains(lines[i], "-->") {
					i++
				}
				if i < len(lines) {
					i++
				}
				continue
			}
			if t == "" || reHeading.MatchString(t) || reFence.MatchString(lines[i]) ||
				strings.HasPrefix(t, ">") || reUL.MatchString(lines[i]) || reOL.MatchString(lines[i]) ||
				reHR.MatchString(lines[i]) || strings.HasPrefix(t, "|") {
				break
			}
			para = append(para, t)
			i++
		}
		if len(para) > 0 {
			n := NewBlock("NodeParagraph", NewID())
			for idx, l := range para {
				if idx > 0 {
					n.AppendNode(NewSoftBreak())
				}
				n.Children = append(n.Children, ParseInline(l)...)
			}
			out = append(out, n)
		}
	}
	return out
}

// CodeBlockNode 构造一个代码块节点。
func CodeBlockNode(lang, code string) *Node {
	n := NewBlock("NodeCodeBlock", NewID())
	n.IsFencedCodeBlock = true
	n.hasFenced = true
	n.Add(
		NewInline("NodeCodeBlockFenceOpenMarker", "```"),
		&Node{Type: "NodeCodeBlockFenceInfoMarker", CodeInfo: base64Encode(lang), hasCodeInfo: true},
		NewInline("NodeCodeBlockCode", code),
		NewInline("NodeCodeBlockFenceCloseMarker", "```"),
	)
	return n
}

func indentWidth(s string) int {
	return len(strings.ReplaceAll(s, "\t", "    "))
}

func parseMDList(lines []string, start int) (*Node, int) {
	ordered := reOL.MatchString(lines[start])
	listType := "NodeList"
	if ordered {
		listType = "NodeOrderedList"
	}
	list := NewBlock(listType, NewID())
	i := start
	baseIndent := -1
	for i < len(lines) {
		l := lines[i]
		m := reUL.FindStringSubmatch(l)
		om := reOL.FindStringSubmatch(l)
		if m == nil && om == nil {
			break
		}
		mm := m
		if mm == nil {
			mm = om
		}
		indent := indentWidth(mm[1])
		if baseIndent < 0 {
			baseIndent = indent
		}
		if indent < baseIndent {
			break
		}
		isOrdered := om != nil
		if indent == baseIndent && isOrdered != ordered {
			break // 同级换了列表类型，交给上层重新开始
		}
		if indent > baseIndent {
			// 理论上不会走到这里（嵌套在收集 item 行时已处理）
			break
		}
		itemLines := []string{mm[2]}
		i++
		for i < len(lines) {
			t := lines[i]
			if strings.TrimSpace(t) == "" {
				j := i + 1
				for j < len(lines) && strings.TrimSpace(lines[j]) == "" {
					j++
				}
				if j < len(lines) && indentWidth(lines[j])-indentWidth(strings.TrimLeft(lines[j], " \t")) > baseIndent {
					itemLines = append(itemLines, "")
					i++
					continue
				}
				break
			}
			if reUL.MatchString(t) || reOL.MatchString(t) {
				break
			}
			lead := len(t) - len(strings.TrimLeft(t, " \t"))
			if indentWidth(t[:lead]) > baseIndent {
				itemLines = append(itemLines, strings.TrimSpace(t))
				i++
				continue
			}
			break
		}
		li := NewBlock("NodeListItem", NewID())
		p := NewBlock("NodeParagraph", NewID())
		p.Children = ParseInline(itemLines[0])
		li.AppendNode(p)
		if len(itemLines) > 1 {
			for _, b := range parseMDBlocks(itemLines[1:]) {
				li.AppendNode(b)
			}
		}
		if li.Prop("id") == "" {
			li.SetProp("id", li.ID)
		}
		list.AppendNode(li)
	}
	return list, i
}

func parseMDTable(lines []string, start int) (*Node, int) {
	table := NewBlock("NodeTable", NewID())
	i := start
	for i < len(lines) {
		t := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(t, "|") {
			break
		}
		if reTableSep.MatchString(t) {
			i++
			continue
		}
		cells := strings.Split(strings.Trim(t, "|"), "|")
		row := NewBlock("NodeTableRow", NewID())
		for _, c := range cells {
			cell := NewBlock("NodeTableCell", NewID())
			p := NewBlock("NodeParagraph", NewID())
			p.Children = ParseInline(strings.TrimSpace(c))
			cell.AppendNode(p)
			row.AppendNode(cell)
		}
		table.AppendNode(row)
		i++
	}
	if len(table.Children) == 0 {
		return nil, i
	}
	return table, i
}

// ---------------------------------------------------------------- 行内解析

// ParseInline 解析一段 Markdown 行内文本为思源行内节点。
func ParseInline(s string) []*Node {
	out := []*Node{}
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			out = append(out, NewText(buf.String()))
			buf.Reset()
		}
	}
	i := 0
	for i < len(s) {
		rest := s[i:]
		switch {
		case s[i] == '\\' && i+1 < len(s):
			buf.WriteByte(s[i+1])
			i += 2
		case strings.HasPrefix(rest, "!["):
			if alt, src, n, ok := parseInlineMarkup(s, i, true); ok {
				flush()
				out = append(out, imageNode(alt, src))
				i = n
				continue
			}
			buf.WriteByte(s[i])
			i++
		case s[i] == '[':
			if text, href, n, ok := parseInlineMarkup(s, i, false); ok {
				flush()
				out = append(out, NewTextMark("a", text, href))
				i = n
				continue
			}
			buf.WriteByte(s[i])
			i++
		case strings.HasPrefix(rest, "**"), strings.HasPrefix(rest, "__"):
			d := rest[:2]
			if inner, n, ok := matchWrap(s, i, d); ok {
				flush()
				out = append(out, NewTextMark("strong", inner, ""))
				i = n
				continue
			}
			buf.WriteByte(s[i])
			i++
		case strings.HasPrefix(rest, "~~"):
			if inner, n, ok := matchWrap(s, i, "~~"); ok {
				flush()
				out = append(out, NewTextMark("s", inner, ""))
				i = n
				continue
			}
			buf.WriteString("~~")
			i += 2
		case strings.HasPrefix(rest, "=="):
			if inner, n, ok := matchWrap(s, i, "=="); ok {
				flush()
				out = append(out, NewTextMark("mark", inner, ""))
				i = n
				continue
			}
			buf.WriteString("==")
			i += 2
		case s[i] == '*':
			if inner, n, ok := matchWrap(s, i, "*"); ok && inner != "" && !strings.Contains(inner, "*") {
				flush()
				out = append(out, NewTextMark("em", inner, ""))
				i = n
				continue
			}
			buf.WriteByte(s[i])
			i++
		case s[i] == '`':
			if j := strings.IndexByte(s[i+1:], '`'); j >= 0 {
				flush()
				out = append(out, NewTextMark("code", s[i+1:i+1+j], ""))
				i = i + j + 2
				continue
			}
			buf.WriteByte(s[i])
			i++
		case strings.HasPrefix(rest, "<u>"), strings.HasPrefix(rest, "<kbd>"),
			strings.HasPrefix(rest, "<sub>"), strings.HasPrefix(rest, "<sup>"),
			strings.HasPrefix(rest, "<s>"), strings.HasPrefix(rest, "<em>"), strings.HasPrefix(rest, "<strong>"):
			name := ""
			mark := ""
			switch {
			case strings.HasPrefix(rest, "<u>"):
				name, mark = "u", "u"
			case strings.HasPrefix(rest, "<kbd>"):
				name, mark = "kbd", "kbd"
			case strings.HasPrefix(rest, "<sub>"):
				name, mark = "sub", "sub"
			case strings.HasPrefix(rest, "<sup>"):
				name, mark = "sup", "sup"
			case strings.HasPrefix(rest, "<s>"):
				name, mark = "s", "s"
			case strings.HasPrefix(rest, "<em>"):
				name, mark = "em", "em"
			case strings.HasPrefix(rest, "<strong>"):
				name, mark = "strong", "strong"
			}
			open, closeTag := "<"+name+">", "</"+name+">"
			if mark != "" {
				if j := strings.Index(rest, closeTag); j > len(open) {
					flush()
					out = append(out, NewTextMark(mark, rest[len(open):j], ""))
					i += j + len(closeTag)
					continue
				}
			}
			buf.WriteByte(s[i])
			i++
		default:
			buf.WriteByte(s[i])
			i++
		}
	}
	flush()
	return out
}

func matchWrap(s string, i int, delim string) (string, int, bool) {
	rest := s[i+len(delim):]
	j := strings.Index(rest, delim)
	if j < 0 {
		return "", 0, false
	}
	return rest[:j], i + 2*len(delim) + j, true
}

// parseInlineMarkup 解析 ![alt](src) 或 [text](href)。
func parseInlineMarkup(s string, i int, image bool) (text, dest string, next int, ok bool) {
	p := i
	if image {
		if !strings.HasPrefix(s[p:], "![") {
			return "", "", 0, false
		}
		p += 2
	} else {
		if s[p] != '[' {
			return "", "", 0, false
		}
		p++
	}
	closeB := strings.IndexByte(s[p:], ']')
	if closeB < 0 {
		return "", "", 0, false
	}
	text = s[p : p+closeB]
	p = p + closeB + 1
	if p >= len(s) || s[p] != '(' {
		return "", "", 0, false
	}
	p++
	depth := 1
	start := p
	for p < len(s) && depth > 0 {
		switch s[p] {
		case '(':
			depth++
		case ')':
			depth--
		}
		p++
	}
	if depth != 0 {
		return "", "", 0, false
	}
	dest = s[start : p-1]
	// 去掉可选标题 "src \"title\""
	if idx := strings.Index(dest, " \""); idx > 0 && strings.HasSuffix(dest, "\"") {
		dest = dest[:idx]
	}
	return text, dest, p, true
}

func imageNode(alt, src string) *Node {
	n := &Node{Type: "NodeImage", Data: "span", hasData: true, props: NewProps()}
	n.Add(
		&Node{Type: "NodeBang", Data: "!", props: NewProps()},
		&Node{Type: "NodeOpenBracket", Data: "[", props: NewProps()},
		&Node{Type: "NodeLinkText", Data: alt, hasData: true, props: NewProps()},
		&Node{Type: "NodeCloseBracket", Data: "]", props: NewProps()},
		&Node{Type: "NodeOpenParen", Data: "(", props: NewProps()},
		&Node{Type: "NodeLinkDest", Data: src, hasData: true, props: NewProps()},
		&Node{Type: "NodeCloseParen", Data: ")", props: NewProps()},
	)
	return n
}
