package siyuan

import (
	"encoding/json"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- 块视图

// Block 是暴露给编辑器的顶层块。
type Block struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	PM   json.RawMessage `json:"pm"`
}

// BlockIn 是编辑器回传的块。
type BlockIn struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	PM      json.RawMessage `json:"pm"`
	Changed bool            `json:"changed"`
}

// DocBlocks 把文档顶层子节点转成编辑器块列表。
func DocBlocks(doc *Node) []Block {
	out := []Block{}
	for _, c := range doc.Children {
		pm := NodeToPM(c)
		raw, err := json.Marshal(pm)
		if err != nil {
			continue
		}
		out = append(out, Block{ID: c.ID, Type: pmNodeType(pm), PM: raw})
	}
	return out
}

// ---------------------------------------------------------------- .sy -> PM

// NodeToPM 把思源块转换为 ProseMirror 顶层节点。
func NodeToPM(n *Node) map[string]any {
	switch n.Type {
	case "NodeHeading":
		level := n.HeadingLevel
		if level < 1 || level > 6 {
			level = 1
		}
		return pmNode("heading", map[string]any{"level": level}, inlineToPM(n.Children))
	case "NodeCodeBlock":
		attrs := map[string]any{}
		if lang := n.Lang(); lang != "" {
			attrs["language"] = lang
		}
		var content []any
		if code := n.CodeBlockCode(); code != "" {
			content = []any{map[string]any{"type": "text", "text": code}}
		}
		return pmNodeAttrs("codeBlock", attrs, content)
	case "NodeBlockquote":
		var kids []any
		for _, c := range n.Children {
			if c.Type == "NodeBlockquoteMarker" {
				continue
			}
			kids = append(kids, blockToPM(c))
		}
		return pmNode("blockquote", nil, kids)
	case "NodeList", "NodeOrderedList":
		t := "bulletList"
		if n.Type == "NodeOrderedList" {
			t = "orderedList"
		}
		var items []any
		for _, c := range n.Children {
			if c.Type != "NodeListItem" {
				continue
			}
			var kids []any
			var run []*Node
			flush := func() {
				if len(run) == 0 {
					return
				}
				kids = append(kids, pmNode("paragraph", nil, inlineToPM(run)))
				run = nil
			}
			for _, ic := range c.Children {
				if ic.IsInline() && ic.Type != "NodeImage" {
					run = append(run, ic)
					continue
				}
				flush()
				kids = append(kids, blockToPM(ic))
			}
			flush()
			items = append(items, pmNode("listItem", nil, kids))
		}
		attrs := map[string]any{}
		if t == "orderedList" {
			if s := strings.TrimSpace(n.Prop("start")); s != "" && s != "1" {
				attrs["start"] = s
			}
		}
		return pmNodeAttrs(t, attrs, items)
	case "NodeThematicBreak":
		return map[string]any{"type": "horizontalRule"}
	case "NodeTable":
		// v1：表格只读渲染，编辑器里降级为纯文本（未编辑的块保存时原样保留）
		return pmNode("paragraph", nil, []any{pmText(tableToText(n))})
	case "NodeParagraph":
		return pmNode("paragraph", nil, inlineToPM(n.Children))
	default:
		if n.IsInline() {
			return pmNode("paragraph", nil, inlineToPM([]*Node{n}))
		}
		var kids []any
		for _, c := range n.Children {
			if c.IsInline() {
				kids = append(kids, inlineToPM([]*Node{c})...)
				continue
			}
			kids = append(kids, blockToPM(c))
		}
		if len(kids) == 0 {
			return pmNode("paragraph", nil, nil)
		}
		return pmNode("paragraph", nil, kids)
	}
}

func blockToPM(n *Node) map[string]any { return NodeToPM(n) }

func tableToText(t *Node) string {
	var rows []string
	for _, row := range t.Children {
		if row.Type != "NodeTableRow" {
			continue
		}
		var cells []string
		for _, cell := range row.Children {
			if cell.Type != "NodeTableCell" {
				continue
			}
			var sb strings.Builder
			for _, b := range cell.Children {
				sb.WriteString(strings.TrimSpace(RenderInlineMD(inlineChildrenOf(b))))
			}
			cells = append(cells, strings.TrimSpace(sb.String()))
		}
		rows = append(rows, strings.Join(cells, " | "))
	}
	return strings.Join(rows, "\n")
}

func inlineChildrenOf(b *Node) []*Node {
	if b.Type == "NodeParagraph" {
		return b.Children
	}
	return []*Node{b}
}

func pmNode(t string, attrs map[string]any, content []any) map[string]any {
	return pmNodeAttrs(t, attrs, content)
}

func pmNodeAttrs(t string, attrs map[string]any, content []any) map[string]any {
	m := map[string]any{"type": t}
	if len(attrs) > 0 {
		m["attrs"] = attrs
	}
	if len(content) > 0 {
		m["content"] = content
	}
	return m
}

func pmText(s string) map[string]any {
	return map[string]any{"type": "text", "text": s}
}

// inlineToPM 转换行内节点序列。
func inlineToPM(nodes []*Node) []any {
	out := []any{}
	appendText := func(text string, marks []any) {
		if text == "" {
			return
		}
		m := map[string]any{"type": "text", "text": text}
		if len(marks) > 0 {
			m["marks"] = marks
		}
		out = append(out, m)
	}
	for _, n := range nodes {
		if n == nil {
			continue
		}
		switch n.Type {
		case "NodeText":
			appendText(CleanText(n.Data), nil)
		case "NodeSoftBreak", "NodeHardBreak":
			out = append(out, map[string]any{"type": "hardBreak"})
		case "NodeBackslash":
			appendText("\\", nil)
		case "NodeKramdownSpanIAL":
			// 保留在 .sy 里，不进编辑器
		case "NodeTextMark":
			appendText(CleanText(n.TextContent), marksToPM(n))
		case "NodeImage":
			alt, src := imageParts(n)
			attrs := map[string]any{"src": src, "alt": alt}
			// 思源把图片的排版信息放在节点 Properties 里：parent-style 决定“一行挤几张”
			// （width: 25%），style 决定缩放尺寸（width: 10000px 表示原始尺寸）。
			// 带进 PM 属性，这样重建图片块（比如只改了文档里别的块）时不会丢排版。
			if v := strings.TrimSpace(n.Prop("parent-style")); v != "" {
				attrs["parentStyle"] = v
			}
			if v := strings.TrimSpace(n.Prop("style")); v != "" {
				attrs["style"] = v
			}
			out = append(out, map[string]any{"type": "image", "attrs": attrs})
		case "NodeLink":
			text, href := linkParts(n)
			appendText(text, []any{map[string]any{"type": "link", "attrs": map[string]any{"href": href, "target": "_blank"}}})
		case "NodeLinkText", "NodeLinkDest":
			appendText(n.Data, nil)
		default:
			if n.IsInline() {
				appendText(CleanText(n.Data), nil)
			}
		}
	}
	return out
}

// marksToPM 把思源 TextMarkType 映射为 ProseMirror marks（只输出编辑器 schema 支持的 mark）。
func marksToPM(n *Node) []any {
	var marks []any
	for _, t := range strings.Fields(n.TextMark) {
		switch t {
		case "strong":
			marks = append(marks, map[string]any{"type": "bold"})
		case "em":
			marks = append(marks, map[string]any{"type": "italic"})
		case "code":
			marks = append(marks, map[string]any{"type": "code"})
		case "s":
			marks = append(marks, map[string]any{"type": "strike"})
		case "a":
			marks = append(marks, map[string]any{"type": "link", "attrs": map[string]any{"href": n.TextHref, "target": "_blank"}})
		}
	}
	return marks
}

// ---------------------------------------------------------------- PM -> .sy

// PMToNodes 把编辑器回传的 PM 节点转换为思源节点（可能产生多个）。
func PMToNodes(raw json.RawMessage) []*Node {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return pmNodeToSyNodes(m)
}

func pmNodeToSyNodes(m map[string]any) []*Node {
	switch pmNodeType(m) {
	case "paragraph":
		n := NewBlock("NodeParagraph", "")
		n.Children = pmInlineToSy(pmContent(m))
		return []*Node{n}
	case "heading":
		n := NewBlock("NodeHeading", "")
		n.HeadingLevel = pmIntAttr(m, "level", 1)
		n.hasHeadingLevel = true
		n.Children = pmInlineToSy(pmContent(m))
		return []*Node{n}
	case "codeBlock":
		n := NewBlock("NodeCodeBlock", "")
		n.IsFencedCodeBlock = true
		n.hasFenced = true
		code := pmPlainText(m)
		lang := strings.ToLower(pmStringAttr(m, "language"))
		info := base64Encode(lang)
		n.Add(
			NewInline("NodeCodeBlockFenceOpenMarker", "```"),
			&Node{Type: "NodeCodeBlockFenceInfoMarker", CodeInfo: info, hasCodeInfo: true},
			NewInline("NodeCodeBlockCode", code),
			NewInline("NodeCodeBlockFenceCloseMarker", "```"),
		)
		return []*Node{n}
	case "blockquote":
		n := NewBlock("NodeBlockquote", "")
		n.AppendNode(&Node{Type: "NodeBlockquoteMarker", Data: ">", hasData: true, props: NewProps()})
		for _, c := range pmContent(m) {
			n.Children = append(n.Children, pmNodeToSyNodes(pmChild(c))...)
		}
		return []*Node{n}
	case "bulletList":
		return listToSy(m, "NodeList")
	case "orderedList":
		n := listToSy(m, "NodeOrderedList")
		if len(n) > 0 {
			if s := pmStringAttr(m, "start"); s != "" && s != "1" {
				n[0].SetProp("start", s)
			}
		}
		return n
	case "horizontalRule":
		return []*Node{NewBlock("NodeThematicBreak", "")}
	case "image":
		p := NewBlock("NodeParagraph", "")
		p.AppendNode(pmImageToSy(m))
		return []*Node{p}
	case "text", "hardBreak":
		// 裸行内节点：包一个段落
		p := NewBlock("NodeParagraph", "")
		p.Children = pmInlineToSy([]any{m})
		return []*Node{p}
	case "listItem":
		// 兜底：listItem 直接出现时按普通块展开
		var out []*Node
		for _, c := range pmContent(m) {
			out = append(out, pmNodeToSyNodes(pmChild(c))...)
		}
		return out
	default:
		// 未知块类型：拍平成段落，内容不丢
		txt := pmPlainText(m)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		p := NewBlock("NodeParagraph", "")
		p.AppendNode(NewText(txt))
		return []*Node{p}
	}
}

func listToSy(m map[string]any, listType string) []*Node {
	list := NewBlock(listType, "")
	for _, it := range pmContent(m) {
		item := pmChild(it)
		if pmNodeType(item) != "listItem" {
			continue
		}
		li := NewBlock("NodeListItem", "")
		var run []any
		flush := func() {
			if len(run) == 0 {
				return
			}
			p := NewBlock("NodeParagraph", "")
			p.Children = pmInlineToSy(run)
			run = nil
			li.Children = append(li.Children, p)
		}
		for _, c := range pmContent(item) {
			child := pmChild(c)
			switch pmNodeType(child) {
			case "paragraph", "heading":
				run = append(run, pmContent(child)...)
			default:
				flush()
				li.Children = append(li.Children, pmNodeToSyNodes(child)...)
			}
		}
		flush()
		list.Children = append(list.Children, li)
	}
	return []*Node{list}
}

// pmInlineToSy 转换 PM 行内节点为思源行内节点。
func pmInlineToSy(items []any) []*Node {
	var out []*Node
	for _, it := range items {
		m := pmChild(it)
		switch pmNodeType(m) {
		case "text":
			text := CleanText(pmStringAttr(m, "text"))
			if text == "" {
				continue
			}
			if marks := pmMarks(m); len(marks) > 0 {
				href := ""
				for _, mk := range marks {
					if mk == "a" {
						href = markHref(m)
					}
				}
				out = append(out, NewTextMark(strings.Join(marks, " "), text, href))
			} else {
				out = append(out, NewText(text))
			}
		case "hardBreak":
			out = append(out, NewSoftBreak())
		case "image":
			out = append(out, pmImageToSy(m))
		default:
			if t := pmPlainText(m); t != "" {
				out = append(out, NewText(t))
			}
		}
	}
	return out
}

// pmMarks 把 PM marks 映射为思源 TextMarkType（按固定顺序拼接）。
func pmMarks(m map[string]any) []string {
	raw, ok := m["marks"].([]any)
	if !ok {
		return nil
	}
	has := map[string]bool{}
	for _, r := range raw {
		mk, _ := r.(map[string]any)
		if t, _ := mk["type"].(string); t != "" {
			has[t] = true
		}
	}
	order := []struct{ pm, sy string }{
		{"bold", "strong"}, {"italic", "em"}, {"strike", "s"},
		{"underline", "u"}, {"code", "code"}, {"mark", "mark"},
		{"highlight", "mark"}, {"link", "a"},
	}
	var out []string
	seen := map[string]bool{}
	for _, o := range order {
		if has[o.pm] && !seen[o.sy] {
			out = append(out, o.sy)
			seen[o.sy] = true
		}
	}
	return out
}

func markHref(m map[string]any) string {
	raw, _ := m["marks"].([]any)
	for _, r := range raw {
		mk, _ := r.(map[string]any)
		if t, _ := mk["type"].(string); t == "link" {
			if attrs, ok := mk["attrs"].(map[string]any); ok {
				if href, ok := attrs["href"].(string); ok {
					return href
				}
			}
		}
	}
	return ""
}

func pmImageToSy(m map[string]any) *Node {
	src := pmStringAttr(m, "src")
	alt := pmStringAttr(m, "alt")
	n := &Node{Type: "NodeImage", Data: "span", hasData: true, props: NewProps()}
	// 只写有值的属性：思源自己的图片节点不会带空的 id 属性，
	// 早期版本给每个重建的图片塞了个 "id":""，造成 .sy 里多出无意义的属性。
	if v := pmStringAttr(m, "parentStyle"); v != "" {
		n.SetProp("parent-style", v)
	}
	if v := pmStringAttr(m, "style"); v != "" {
		n.SetProp("style", v)
	}
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

// ---------------------------------------------------------------- PM 通用

func pmChild(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func pmNodeType(m map[string]any) string {
	t, _ := m["type"].(string)
	return t
}

func pmContent(m map[string]any) []any {
	if c, ok := m["content"].([]any); ok {
		return c
	}
	return nil
}

func pmAttr(m map[string]any, key string) any {
	attrs, ok := m["attrs"].(map[string]any)
	if !ok {
		return nil
	}
	return attrs[key]
}

func pmStringAttr(m map[string]any, key string) string {
	// 先查顶层字段（如 text），再查 attrs（如 src/language/href）
	if v, ok := m[key]; ok {
		switch t := v.(type) {
		case string:
			return t
		case float64:
			b, _ := json.Marshal(t)
			return string(b)
		case bool:
			if t {
				return "true"
			}
			return "false"
		}
	}
	switch v := pmAttr(m, key).(type) {
	case string:
		return v
	case float64:
		b, _ := json.Marshal(v)
		return string(b)
	case bool:
		if v {
			return "true"
		}
		return "false"
	}
	return ""
}

func pmIntAttr(m map[string]any, key string, def int) int {
	switch v := pmAttr(m, key).(type) {
	case float64:
		if v > 0 {
			return int(v)
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// pmPlainText 拼接节点下所有文本。
func pmPlainText(m map[string]any) string {
	var sb strings.Builder
	var walk func(mm map[string]any)
	walk = func(mm map[string]any) {
		if t, ok := mm["text"].(string); ok {
			sb.WriteString(t)
		}
		for _, c := range pmContent(mm) {
			walk(pmChild(c))
		}
	}
	walk(m)
	return sb.String()
}

// ---------------------------------------------------------------- 写回

// ApplyBlocks 按编辑器回传的块列表重写文档子节点，返回是否真的有变化。
// 未改动的块直接复用原节点（保真），改动的块按 PM 重建但保留原块 ID 与 Properties。
func ApplyBlocks(doc *Node, blocks []BlockIn) bool {
	orig := map[string]*Node{}
	for _, c := range doc.Children {
		if c.ID != "" {
			orig[c.ID] = c
		}
	}
	out := []*Node{}
	changed := false
	for i, b := range blocks {
		if b.ID != "" && !b.Changed {
			if n, ok := orig[b.ID]; ok {
				if i >= len(doc.Children) || doc.Children[i] != n {
					changed = true // 顺序变了或块被移动
				}
				out = append(out, n) // 原样复用，零损失
				continue
			}
		}
		changed = true
		nodes := PMToNodes(b.PM)
		if len(nodes) == 0 {
			continue
		}
		keepID := b.ID
		if keepID == "" {
			keepID = NewID()
		}
		first := nodes[0]
		first.ID = keepID
		if o, ok := orig[keepID]; ok && o.Props() != nil {
			// 保留原有 Properties（含自定义属性），只刷新 id
			first.props = o.Props().Clone()
		}
		if first.Props() == nil {
			first.props = NewProps()
		}
		first.SetProp("id", keepID)
		for _, extra := range nodes[1:] {
			if extra.ID == "" {
				extra.ID = NewID()
				extra.SetProp("id", extra.ID)
			}
		}
		out = append(out, nodes...)
	}
	doc.Children = out
	if len(out) != len(orig) {
		changed = true
	}
	if changed {
		doc.SetProp("updated", NowStamp())
	}
	return changed
}
