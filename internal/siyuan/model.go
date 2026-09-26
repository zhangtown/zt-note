// Package siyuan 实现思源笔记 .sy JSON 的解析、序列化与渲染。
//
// 保真（fidelity）是第一原则：未改动的节点必须能 parse → marshal 后与原文**逐字节一致**，
// 因此对象键顺序、未知字段、原始 JSON 值全部原样保留（见 Node.order / Node.extra）。
package siyuan

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
)

// KV 是一个保留原始顺序的 JSON 键值对。
type KV struct {
	K string
	V json.RawMessage
}

// Props 是保留键顺序的 JSON 对象（对应 SiYuan 的 "Properties"）。
type Props struct {
	kv []KV
}

func NewProps() *Props { return &Props{} }

func (p *Props) Len() int {
	if p == nil {
		return 0
	}
	return len(p.kv)
}

func (p *Props) Keys() []string {
	out := make([]string, 0, p.Len())
	for _, e := range p.kv {
		out = append(out, e.K)
	}
	return out
}

// Raw 返回原始 JSON 值。
func (p *Props) Raw(k string) (json.RawMessage, bool) {
	if p == nil {
		return nil, false
	}
	for _, e := range p.kv {
		if e.K == k {
			return e.V, true
		}
	}
	return nil, false
}

// Get 返回字符串值（非字符串值返回其原始 JSON 文本）。
func (p *Props) Get(k string) (string, bool) {
	raw, ok := p.Raw(k)
	if !ok {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, true
	}
	return string(raw), true
}

func (p *Props) Set(k, v string) {
	b, _ := json.Marshal(v)
	p.SetRaw(k, b)
}

func (p *Props) SetRaw(k string, raw json.RawMessage) {
	for i, e := range p.kv {
		if e.K == k {
			p.kv[i].V = raw
			return
		}
	}
	p.kv = append(p.kv, KV{k, raw})
}

func (p *Props) Delete(k string) {
	for i, e := range p.kv {
		if e.K == k {
			p.kv = append(p.kv[:i], p.kv[i+1:]...)
			return
		}
	}
}

func (p *Props) Clone() *Props {
	if p == nil {
		return nil
	}
	c := &Props{kv: make([]KV, len(p.kv))}
	for i, e := range p.kv {
		c.kv[i] = KV{e.K, append(json.RawMessage(nil), e.V...)}
	}
	return c
}

func (p *Props) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, e := range p.kv {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, _ := json.Marshal(e.K)
		buf.Write(kb)
		buf.WriteByte(':')
		if len(e.V) == 0 {
			buf.WriteString("null")
		} else {
			buf.Write(e.V)
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// parseProps 从解码器读取一个 JSON 对象（或 null），保留键顺序与原始值。
func parseProps(d *json.Decoder) (*Props, error) {
	tok, err := d.Token()
	if err != nil {
		return nil, err
	}
	if tok == nil {
		return nil, nil
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil, fmt.Errorf("siyuan: Properties 不是对象")
	}
	p := &Props{}
	if delim != '{' {
		return nil, nil // null / 其他标量
	}
	for d.More() {
		kt, err := d.Token()
		if err != nil {
			return nil, err
		}
		key, _ := kt.(string)
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return nil, err
		}
		p.kv = append(p.kv, KV{key, raw})
	}
	if _, err := d.Token(); err != nil { // consume '}'
		return nil, err
	}
	return p, nil
}

// Node 是一个 .sy 节点（文档或块或行内节点）。
type Node struct {
	// 原样保留
	order []string // 原始键顺序（构造出的节点为 nil）
	extra []KV     // 未知键（按原顺序）
	props *Props   // Properties

	Type        string
	ID          string
	Spec        string
	Data        string
	TextMark    string // TextMarkType
	TextContent string // TextMarkTextContent
	TextHref    string // TextMarkAHref
	CodeInfo    string // CodeBlockInfo（base64 编码的语言）

	HeadingLevel      int
	IsFencedCodeBlock bool

	Children []*Node

	// 字段是否存在（区分零值与缺失）
	hasData, hasMark, hasCodeInfo          bool
	hasHeadingLevel, hasFenced, hasContent bool
}

// ---------------------------------------------------------------- 解析

// Parse 解析一个 .sy 文档。
func Parse(data []byte) (*Node, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	n, err := parseNode(d)
	if err != nil {
		return nil, err
	}
	return n, nil
}

// parsePropsRaw 从原始 JSON 解析 Properties。
func parsePropsRaw(raw json.RawMessage) (*Props, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	return parseProps(json.NewDecoder(bytes.NewReader(raw)))
}

func parseNode(d *json.Decoder) (*Node, error) {
	tok, err := d.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("siyuan: 节点不是 JSON 对象")
	}
	n := &Node{}
	for d.More() {
		kt, err := d.Token()
		if err != nil {
			return nil, err
		}
		key, _ := kt.(string)
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return nil, err
		}
		n.order = append(n.order, key)
		switch key {
		case "Type":
			_ = json.Unmarshal(raw, &n.Type)
		case "ID":
			_ = json.Unmarshal(raw, &n.ID)
		case "Spec":
			_ = json.Unmarshal(raw, &n.Spec)
		case "Data":
			_ = json.Unmarshal(raw, &n.Data)
			n.hasData = true
		case "HeadingLevel":
			_ = json.Unmarshal(raw, &n.HeadingLevel)
			n.hasHeadingLevel = true
		case "IsFencedCodeBlock":
			_ = json.Unmarshal(raw, &n.IsFencedCodeBlock)
			n.hasFenced = true
		case "TextMarkType":
			_ = json.Unmarshal(raw, &n.TextMark)
			n.hasMark = true
		case "TextMarkTextContent":
			_ = json.Unmarshal(raw, &n.TextContent)
			n.hasContent = true
		case "TextMarkAHref":
			_ = json.Unmarshal(raw, &n.TextHref)
		case "CodeBlockInfo":
			_ = json.Unmarshal(raw, &n.CodeInfo)
			n.hasCodeInfo = true
		case "Properties":
			p, err := parsePropsRaw(raw)
			if err != nil {
				return nil, err
			}
			n.props = p
		case "Children":
			kids, err := parseChildren(raw)
			if err != nil {
				return nil, err
			}
			n.Children = kids
		default:
			n.extra = append(n.extra, KV{key, raw})
		}
	}
	if _, err := d.Token(); err != nil { // consume '}'
		return nil, err
	}
	return n, nil
}

func parseChildren(raw json.RawMessage) ([]*Node, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	tok, err := d.Token()
	if err != nil {
		return nil, nil // null
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '[' {
		return nil, nil
	}
	var out []*Node
	for d.More() {
		c, err := parseNode(d)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------- 序列化

// Marshal 序列化为紧凑 JSON（与思源写法一致）。
func (n *Node) Marshal() []byte {
	b, err := json.Marshal(n)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func (n *Node) MarshalJSON() ([]byte, error) {
	fields := n.fieldMap()
	keys := n.order
	if keys == nil {
		keys = canonicalOrder(n)
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	emit := func(k string) {
		raw, ok := fields[k]
		if !ok {
			return
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		kb, _ := json.Marshal(k)
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(raw)
		delete(fields, k)
	}
	for _, k := range keys {
		emit(k)
	}
	// 构造出的新键（order 里没有的）按规范顺序补齐
	for _, k := range canonicalOrder(n) {
		emit(k)
	}
	// 剩余未知键
	for _, e := range n.extra {
		emit(e.K)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// fieldMap 把当前字段值编码为原始 JSON。
func (n *Node) fieldMap() map[string]json.RawMessage {
	m := map[string]json.RawMessage{}
	put := func(k string, v any) {
		b, err := json.Marshal(v)
		if err == nil {
			m[k] = b
		}
	}
	if n.Type != "" {
		put("Type", n.Type)
	}
	if n.ID != "" {
		put("ID", n.ID)
	}
	if n.Spec != "" {
		put("Spec", n.Spec)
	}
	if n.hasData {
		put("Data", n.Data)
	}
	if n.hasHeadingLevel {
		put("HeadingLevel", n.HeadingLevel)
	}
	if n.hasFenced {
		put("IsFencedCodeBlock", n.IsFencedCodeBlock)
	}
	if n.hasMark {
		put("TextMarkType", n.TextMark)
	}
	if n.hasContent {
		put("TextMarkTextContent", n.TextContent)
	}
	if n.TextHref != "" {
		put("TextMarkAHref", n.TextHref)
	}
	if n.hasCodeInfo {
		put("CodeBlockInfo", n.CodeInfo)
	}
	if n.props != nil {
		m["Properties"] = json.RawMessage(mustJSON(n.props))
	}
	if n.Children != nil {
		m["Children"] = json.RawMessage(mustJSON(n.Children))
	}
	for _, e := range n.extra {
		m[e.K] = e.V
	}
	return m
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return b
}

// canonicalOrder 返回节点键的规范顺序（新构造节点使用），与思源输出风格一致。
func canonicalOrder(n *Node) []string {
	switch n.Type {
	case "NodeText", "NodeSoftBreak", "NodeHardBreak", "NodeTextMark", "NodeImage", "NodeLink",
		"NodeLinkText", "NodeLinkDest", "NodeKramdownSpanIAL", "NodeBackslash", "NodeBang",
		"NodeOpenBracket", "NodeCloseBracket", "NodeOpenParen", "NodeCloseParen",
		"NodeCodeBlockFenceOpenMarker", "NodeCodeBlockFenceInfoMarker", "NodeCodeBlockFenceCloseMarker",
		"NodeCodeBlockCode", "NodeBlockquoteMarker", "NodeHTMLInline", "NodeMathBlockInline":
		// 行内/标记节点：Type 在前，无 ID
		return []string{"Type", "Data", "TextMarkType", "TextMarkTextContent", "TextMarkAHref", "CodeBlockInfo", "Properties", "Children"}
	default:
		// 块级与文档：ID, Spec, Type, 类型特有字段, Properties, Children
		return []string{"ID", "Spec", "Type", "HeadingLevel", "IsFencedCodeBlock", "Properties", "Children"}
	}
}

// ---------------------------------------------------------------- 构造与访问

func NewText(s string) *Node {
	return &Node{Type: "NodeText", Data: s, hasData: true, props: NewProps()}
}

func NewSoftBreak() *Node {
	return &Node{Type: "NodeSoftBreak", Data: "\n", hasData: true, props: NewProps()}
}

func NewTextMark(kind, content, href string) *Node {
	n := &Node{Type: "NodeTextMark", TextMark: kind, TextContent: content, hasMark: true, hasContent: true}
	if href != "" {
		n.TextHref = href
	}
	return n
}

// NewBlock 创建一个块级节点（带 ID 与 Properties）。
func NewBlock(nodeType, id string) *Node {
	n := &Node{Type: nodeType, ID: id, props: NewProps()}
	n.SetProp("id", id)
	n.SetProp("updated", time.Now().Format("20060102150405"))
	return n
}

// NewInline 创建一个无 ID 的行内节点。
func NewInline(nodeType, data string) *Node {
	n := &Node{Type: nodeType, props: NewProps()}
	n.SetProp("id", "")
	if data != "" {
		n.Data = data
		n.hasData = true
	}
	return n
}

func (n *Node) Prop(k string) string {
	if n == nil || n.props == nil {
		return ""
	}
	v, _ := n.props.Get(k)
	return v
}

func (n *Node) Props() *Props { return n.props }

func (n *Node) SetProp(k, v string) {
	if n.props == nil {
		n.props = NewProps()
	}
	n.props.Set(k, v)
}

func (n *Node) DelProp(k string) {
	if n.props != nil {
		n.props.Delete(k)
	}
}

func (n *Node) SetData(s string) {
	n.Data = s
	n.hasData = true
}

func (n *Node) HasData() bool { return n.hasData }

func (n *Node) Text() string {
	switch n.Type {
	case "NodeText", "NodeSoftBreak", "NodeHardBreak", "NodeBackslash", "NodeCodeBlockCode",
		"NodeLinkText", "NodeLinkDest", "NodeKramdownSpanIAL", "NodeBlockquoteMarker":
		return n.Data
	case "NodeTextMark":
		return n.TextContent
	}
	var sb strings.Builder
	for _, c := range n.Children {
		sb.WriteString(c.Text())
	}
	return sb.String()
}

func (n *Node) Add(children ...*Node) *Node {
	n.Children = append(n.Children, children...)
	return n
}

// AppendNode 保持Children 非 nil 语义（空切片会序列化为 []，nil 则省略该键）。
func (n *Node) AppendNode(c *Node) {
	if n.Children == nil {
		n.Children = []*Node{}
	}
	n.Children = append(n.Children, c)
}

func (n *Node) Find(id string) *Node {
	if n == nil {
		return nil
	}
	if n.ID == id {
		return n
	}
	for _, c := range n.Children {
		if r := c.Find(id); r != nil {
			return r
		}
	}
	return nil
}

func (n *Node) Clone() *Node {
	if n == nil {
		return nil
	}
	c := &Node{
		Type: n.Type, ID: n.ID, Spec: n.Spec, Data: n.Data,
		TextMark: n.TextMark, TextContent: n.TextContent, TextHref: n.TextHref,
		CodeInfo: n.CodeInfo, HeadingLevel: n.HeadingLevel, IsFencedCodeBlock: n.IsFencedCodeBlock,
		hasData: n.hasData, hasMark: n.hasMark, hasCodeInfo: n.hasCodeInfo,
		hasHeadingLevel: n.hasHeadingLevel, hasFenced: n.hasFenced, hasContent: n.hasContent,
		props: n.props.Clone(),
	}
	c.order = append([]string(nil), n.order...)
	for _, e := range n.extra {
		c.extra = append(c.extra, KV{e.K, append(json.RawMessage(nil), e.V...)})
	}
	for _, k := range n.Children {
		c.Children = append(c.Children, k.Clone())
	}
	return c
}

// ---------------------------------------------------------------- 工具

// NewID 生成思源风格 ID：yyyyMMddHHmmss + "-" + 7 位小写字母数字。
func NewID() string {
	return NowStamp() + "-" + RandStr(7)
}

func NowStamp() string { return time.Now().Format("20060102150405") }

const idChars = "abcdefghijklmnopqrstuvwxyz0123456789"

func RandStr(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = idChars[rand.IntN(len(idChars))]
	}
	return string(b)
}

// IsBoxID 判断是否为思源笔记本 ID（yyyyMMddHHmmss-xxxxxxx）。
func IsBoxID(s string) bool {
	if len(s) != 22 || s[14] != '-' {
		return false
	}
	for i := 0; i < 14; i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	for i := 15; i < 22; i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// IsDocID 与笔记本 ID 格式相同。
func IsDocID(s string) bool { return IsBoxID(s) }

// CleanText 去掉思源在行内代码两侧插入的零宽字符。
func CleanText(s string) string {
	if !strings.ContainsAny(s, "\u200b\u200c\u200d") {
		return s
	}
	return strings.Map(func(r rune) rune {
		switch r {
		case '\u200b', '\u200c', '\u200d':
			return -1
		}
		return r
	}, s)
}

// Lang 返回代码块语言（CodeBlockInfo 是 base64）。
func (n *Node) Lang() string {
	if n.CodeInfo == "" {
		return ""
	}
	dec, err := base64Decode(n.CodeInfo)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(dec))
	if s == "undefined" {
		return ""
	}
	return s
}

// CodeBlockCode 返回代码块源码。
func (n *Node) CodeBlockCode() string {
	for _, c := range n.Children {
		if c.Type == "NodeCodeBlockCode" {
			return c.Data
		}
	}
	return ""
}

// IsInline 返回节点是否为行内节点。
func (n *Node) IsInline() bool {
	switch n.Type {
	case "NodeText", "NodeSoftBreak", "NodeHardBreak", "NodeTextMark", "NodeImage", "NodeLink",
		"NodeKramdownSpanIAL", "NodeBackslash", "NodeLinkText", "NodeLinkDest",
		"NodeBang", "NodeOpenBracket", "NodeCloseBracket", "NodeOpenParen", "NodeCloseParen":
		return true
	}
	return false
}
