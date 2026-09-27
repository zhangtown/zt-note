// Package store 管理工作区目录（思源布局：<root>/data/<box>/<doc>.sy）。
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"ztnote/internal/siyuan"
)

// Store 是笔记工作区的读写入口。
type Store struct {
	Root string // 工作区根目录（含 data/）
	mu   sync.Mutex
}

func New(root string) *Store { return &Store{Root: root} }

func (s *Store) DataDir() string   { return filepath.Join(s.Root, "data") }
func (s *Store) AssetsDir() string { return filepath.Join(s.DataDir(), "assets") }
func (s *Store) HistoryDir() string {
	return filepath.Join(s.Root, "history")
}

// Ensure 建立目录结构。
func (s *Store) Ensure() error {
	for _, d := range []string{s.DataDir(), s.AssetsDir(), s.HistoryDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- 数据结构

type Notebook struct {
	ID    string     `json:"id"`
	Name  string     `json:"name"`
	Count int        `json:"count"`
	Docs  []*DocMeta `json:"docs"`
}

type DocMeta struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Updated  string     `json:"updated"`
	Box      string     `json:"box"`
	ReadOnly bool       `json:"readonly,omitempty"`
	Children []*DocMeta `json:"children,omitempty"`
}

// DocRef 指向磁盘上的一篇文档。
type DocRef struct {
	Box   string
	ID    string
	Path  string
	Title string
}

// DocDetail 是编辑器需要的文档视图。
type DocDetail struct {
	ID       string          `json:"id"`
	Box      string          `json:"box"`
	Title    string          `json:"title"`
	Updated  string          `json:"updated"`
	ReadOnly bool            `json:"readonly"`
	HTML     string          `json:"html"`
	Blocks   []siyuan.Block  `json:"blocks"`
	Raw      json.RawMessage `json:"-"`
}

// Hit 是一条搜索结果。
type Hit struct {
	Box     string `json:"box"`
	ID      string `json:"id"`
	Title   string `json:"title"`
	BlockID string `json:"blockId"`
	Snippet string `json:"snippet"`
}

// ---------------------------------------------------------------- 笔记本

// reservedDir 判断 data 目录下的系统目录（不当作笔记本，也不允许删）。
func reservedDir(name string) bool {
	switch name {
	case "assets", "templates", "storage", "widgets", "plugins", "emojis":
		return true
	}
	return strings.HasPrefix(name, ".")
}

// Notebooks 返回全部笔记本与文档树。
func (s *Store) Notebooks() ([]*Notebook, error) {
	entries, err := os.ReadDir(s.DataDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []*Notebook{}, nil
		}
		return nil, err
	}
	out := []*Notebook{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if reservedDir(name) {
			continue
		}
		dir := filepath.Join(s.DataDir(), name)
		docs, err := s.scanDocs(name, dir)
		if err != nil {
			continue
		}
		if len(docs) == 0 && !siyuan.IsBoxID(name) {
			continue
		}
		nb := &Notebook{ID: name, Name: s.notebookName(name), Docs: docs, Count: len(docs)}
		out = append(out, nb)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Store) notebookName(box string) string {
	conf := filepath.Join(s.DataDir(), box, ".siyuan", "conf.json")
	if raw, err := os.ReadFile(conf); err == nil {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if name, ok := m["name"].(string); ok && strings.TrimSpace(name) != "" {
				return name
			}
		}
	}
	return box
}

// scanDocs 扫描某笔记本下的所有 .sy，并按目录层级构建文档树。
func (s *Store) scanDocs(box, boxDir string) ([]*DocMeta, error) {
	metas := map[string]*DocMeta{} // docID -> meta
	paths := map[string]string{}   // docID -> path
	parents := map[string]string{} // docID -> parent docID

	err := filepath.Walk(boxDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if info.Name() == ".siyuan" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".sy") {
			return nil
		}
		rel, _ := filepath.Rel(boxDir, p)
		doc, err := readDocMeta(p)
		if err != nil {
			return nil
		}
		if doc.ID == "" {
			doc.ID = strings.TrimSuffix(filepath.Base(p), ".sy")
		}
		doc.Box = box
		metas[doc.ID] = doc
		paths[doc.ID] = p
		// 父文档：所在目录名（若该目录名本身是一篇文档 ID 且不是 box 目录）
		dir := filepath.Dir(rel)
		if dir != "." {
			parts := strings.Split(filepath.ToSlash(dir), "/")
			last := parts[len(parts)-1]
			if last != box && siyuan.IsBoxID(last) {
				parents[doc.ID] = last
			} else if len(parts) > 1 {
				parents[doc.ID] = parts[len(parts)-1]
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	roots := []*DocMeta{}
	ids := make([]string, 0, len(metas))
	for id := range metas {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		meta := metas[id]
		if pid, ok := parents[id]; ok {
			if parent, ok := metas[pid]; ok {
				parent.Children = append(parent.Children, meta)
				continue
			}
		}
		roots = append(roots, meta)
	}
	sortMetas(roots)
	return roots, nil
}

func sortMetas(list []*DocMeta) {
	sort.SliceStable(list, func(i, j int) bool {
		ti, tj := strings.ToLower(list[i].Title), strings.ToLower(list[j].Title)
		if ti == tj {
			return list[i].ID < list[j].ID
		}
		return ti < tj
	})
	for _, m := range list {
		if len(m.Children) > 0 {
			sortMetas(m.Children)
		}
	}
}

func readDocMeta(path string) (*DocMeta, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc, err := siyuan.Parse(raw)
	if err != nil {
		return nil, err
	}
	return &DocMeta{
		ID:      doc.ID,
		Title:   siyuan.DocTitle(doc),
		Updated: siyuan.Updated(doc),
	}, nil
}

// ---------------------------------------------------------------- 文档读写

// FindDoc 在模板内查找文档路径。
func (s *Store) FindDoc(box, id string) (string, error) {
	boxDir := filepath.Join(s.DataDir(), box)
	direct := filepath.Join(boxDir, id+".sy")
	if _, err := os.Stat(direct); err == nil {
		return direct, nil
	}
	var found string
	_ = filepath.Walk(boxDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, ".sy") && strings.TrimSuffix(filepath.Base(p), ".sy") == id {
			found = p
			return filepath.SkipAll
		}
		return nil
	})
	if found == "" {
		return "", fmt.Errorf("文档不存在: %s/%s", box, id)
	}
	return found, nil
}

// Load 读取文档。
func (s *Store) Load(box, id string) (*siyuan.Node, string, error) {
	path, err := s.FindDoc(box, id)
	if err != nil {
		return nil, "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	doc, err := siyuan.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	return doc, path, nil
}

// Detail 读取文档并准备编辑器视图。
func (s *Store) Detail(box, id string) (*DocDetail, error) {
	doc, _, err := s.Load(box, id)
	if err != nil {
		return nil, err
	}
	return &DocDetail{
		ID:       doc.ID,
		Box:      box,
		Title:    siyuan.DocTitle(doc),
		Updated:  siyuan.Updated(doc),
		ReadOnly: doc.Prop("custom-sy-readonly") == "true" || doc.Prop("readonly") == "true",
		HTML:     siyuan.RenderDocHTML(doc),
		Blocks:   siyuan.DocBlocks(doc),
	}, nil
}

// Save 写回文档（原子写 + 备份）。
func (s *Store) Save(box, id string, doc *siyuan.Node) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.FindDoc(box, id)
	if err != nil {
		return err
	}
	return s.writeDoc(path, doc)
}

func (s *Store) writeDoc(path string, doc *siyuan.Node) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil {
		s.backup(path, old)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, doc.Marshal(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// backup 保留最近一次修改前的版本（history/<box>/<doc>-<时间戳>.sy）。
func (s *Store) backup(path string, content []byte) {
	box := filepath.Base(filepath.Dir(path))
	name := strings.TrimSuffix(filepath.Base(path), ".sy")
	dir := filepath.Join(s.HistoryDir(), box)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	dst := filepath.Join(dir, name+"-"+siyuan.NowStamp()+"-"+siyuan.RandStr(4)+".sy")
	_ = os.WriteFile(dst, content, 0o644)
	s.pruneBackups(dir, 20)
}

func (s *Store) pruneBackups(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	if len(entries) <= keep {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for i := 0; i < len(names)-keep; i++ {
		_ = os.Remove(filepath.Join(dir, names[i]))
	}
}

// SaveBlocks 应用编辑器回传的块列表。
func (s *Store) SaveBlocks(box, id string, blocks []siyuan.BlockIn) (*DocDetail, error) {
	s.mu.Lock()
	doc, path, err := s.Load(box, id)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if !siyuan.ApplyBlocks(doc, blocks) {
		// 无任何变化：不写盘、不动 updated，保证字节级保真
		s.mu.Unlock()
		return s.Detail(box, id)
	}
	if err := s.writeDocNoLock(path, doc); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()
	return s.Detail(box, id)
}

func (s *Store) writeDocNoLock(path string, doc *siyuan.Node) error {
	if old, err := os.ReadFile(path); err == nil {
		s.backup(path, old)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, doc.Marshal(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// CreateDoc 新建文档（支持子文档），返回新文档 ID。
func (s *Store) CreateDoc(box, title, parentID string) (*DocMeta, error) {
	id := siyuan.NewID()
	if strings.TrimSpace(title) == "" {
		title = "未命名文档"
	}
	dir := filepath.Join(s.DataDir(), box)
	if parentID != "" {
		if _, err := s.FindDoc(box, parentID); err == nil {
			dir = filepath.Join(dir, parentID)
		}
	}
	path := filepath.Join(dir, id+".sy")
	doc := siyuan.NewDoc(id, title)
	if err := s.writeDoc(path, doc); err != nil {
		return nil, err
	}
	return &DocMeta{ID: id, Title: title, Updated: siyuan.Updated(doc), Box: box}, nil
}

// Rename 修改文档标题。
func (s *Store) Rename(box, id, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, path, err := s.Load(box, id)
	if err != nil {
		return err
	}
	doc.SetProp("title", title)
	doc.SetProp("updated", siyuan.NowStamp())
	return s.writeDocNoLock(path, doc)
}

// Delete 删除文档（含其子文档目录）。
func (s *Store) Delete(box, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.FindDoc(box, id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	sub := filepath.Join(filepath.Dir(path), id)
	if st, err := os.Stat(sub); err == nil && st.IsDir() {
		_ = os.RemoveAll(sub)
	}
	return nil
}

// 笔记本操作的错误分类：HTTP 层用 errors.Is 映射状态码，不去解析错误文本。
var (
	// ErrBadBoxID 不是合法的笔记本 id（空、带分隔符、系统目录、隐藏目录）
	ErrBadBoxID = errors.New("非法笔记本 id")
	// ErrNotebookAbsent 目录不存在或不是目录
	ErrNotebookAbsent = errors.New("笔记本不存在")
	// ErrEmptyNotebookName 改名成空名字
	ErrEmptyNotebookName = errors.New("笔记本名不能为空")
)

// CreateNotebook 新建笔记本（思源目录约定：<boxID>/.siyuan/conf.json）。
func (s *Store) CreateNotebook(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		name = "新笔记本"
	}
	id := siyuan.NewID()
	dir := filepath.Join(s.DataDir(), id)
	if err := os.MkdirAll(filepath.Join(dir, ".siyuan"), 0o755); err != nil {
		return "", err
	}
	conf := map[string]any{"name": name, "sort": 0, "closed": false}
	raw, _ := json.Marshal(conf)
	if err := os.WriteFile(filepath.Join(dir, ".siyuan", "conf.json"), raw, 0o644); err != nil {
		return "", err
	}
	return id, nil
}

// RenameNotebook 修改笔记本名（写进 <box>/.siyuan/conf.json 的 name，思源自己读的也是它）。
func (s *Store) RenameNotebook(box, name string) error {
	if box == "" || reservedDir(box) || strings.ContainsAny(box, "/\\") {
		return fmt.Errorf("%w: %s", ErrBadBoxID, box)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return ErrEmptyNotebookName
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.DataDir(), box)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return fmt.Errorf("%w: %s", ErrNotebookAbsent, box)
	}
	confDir := filepath.Join(dir, ".siyuan")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return err
	}
	conf := filepath.Join(confDir, "conf.json")
	m := map[string]any{}
	if raw, err := os.ReadFile(conf); err == nil {
		_ = json.Unmarshal(raw, &m)
		if m == nil {
			m = map[string]any{}
		}
	}
	m["name"] = name
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return os.WriteFile(conf, raw, 0o644)
}

// DeleteNotebook 删除笔记本（连同其中的文档目录）。
// 只允许删 data 下的真实笔记本目录：assets/templates 等系统目录一律拒绝，
// 免得把图片资源或工作区根目录删掉。
func (s *Store) DeleteNotebook(box string) error {
	if box == "" || reservedDir(box) || strings.ContainsAny(box, "/\\") {
		return fmt.Errorf("%w: %s", ErrBadBoxID, box)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.DataDir(), box)
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return fmt.Errorf("%w: %s", ErrNotebookAbsent, box)
	}
	return os.RemoveAll(dir)
}

// EnsureNotebook 确保笔记本存在（导入时用），返回 box id。
func (s *Store) EnsureNotebook(id, name string) (string, error) {
	if id == "" || !siyuan.IsBoxID(id) {
		id = siyuan.NewID()
	}
	dir := filepath.Join(s.DataDir(), id)
	if err := os.MkdirAll(filepath.Join(dir, ".siyuan"), 0o755); err != nil {
		return "", err
	}
	confPath := filepath.Join(dir, ".siyuan", "conf.json")
	if _, err := os.Stat(confPath); err != nil {
		raw, _ := json.Marshal(map[string]any{"name": name, "sort": 0, "closed": false})
		if err := os.WriteFile(confPath, raw, 0o644); err != nil {
			return "", err
		}
	}
	return id, nil
}

// WriteDoc 直接写入一篇文档（导入用）。
func (s *Store) WriteDoc(box string, doc *siyuan.Node, parentID string) (string, error) {
	dir := filepath.Join(s.DataDir(), box)
	if parentID != "" {
		dir = filepath.Join(dir, parentID)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, doc.ID+".sy")
	if _, err := os.Stat(path); err == nil {
		// ID 冲突：换新 ID 保留两篇
		newID := siyuan.NewID()
		doc.ID = newID
		doc.SetProp("id", newID)
		path = filepath.Join(dir, newID+".sy")
	}
	return path, os.WriteFile(path, doc.Marshal(), 0o644)
}

// ---------------------------------------------------------------- 遍历与搜索

// AllDocs 遍历所有文档。
func (s *Store) AllDocs() []DocRef {
	var out []DocRef
	nbs, err := s.Notebooks()
	if err != nil {
		return out
	}
	for _, nb := range nbs {
		var walk func(list []*DocMeta)
		walk = func(list []*DocMeta) {
			for _, m := range list {
				path, err := s.FindDoc(nb.ID, m.ID)
				if err == nil {
					out = append(out, DocRef{Box: nb.ID, ID: m.ID, Path: path, Title: m.Title})
				}
				walk(m.Children)
			}
		}
		walk(nb.Docs)
	}
	return out
}

// Search 全文搜索（标题 + 正文，忽略大小写）。
func (s *Store) Search(q string, limit int) []Hit {
	hits := []Hit{}
	q = strings.TrimSpace(q)
	if q == "" {
		return hits
	}
	lower := strings.ToLower(q)
	if limit <= 0 {
		limit = 50
	}
	for _, ref := range s.AllDocs() {
		if len(hits) >= limit {
			break
		}
		raw, err := os.ReadFile(ref.Path)
		if err != nil {
			continue
		}
		doc, err := siyuan.Parse(raw)
		if err != nil {
			continue
		}
		title := siyuan.DocTitle(doc)
		if strings.Contains(strings.ToLower(title), lower) {
			// 标题命中 = 整篇命中：BlockID 留空，前端据此不做块级定位
			// （思源的文档 ID 不等于任何块的 data-node-id，填 doc.ID 会让前端定位落空）
			hits = append(hits, Hit{Box: ref.Box, ID: ref.ID, Title: title, Snippet: title})
			continue
		}
		for _, b := range doc.Children {
			if len(hits) >= limit {
				break
			}
			text := b.Text()
			idx := strings.Index(strings.ToLower(text), lower)
			if idx < 0 {
				continue
			}
			hits = append(hits, Hit{Box: ref.Box, ID: ref.ID, Title: title, BlockID: b.ID, Snippet: snippet(text, idx, len(q))})
		}
	}
	return hits
}

func snippet(text string, idx, qlen int) string {
	runes := []rune(text)
	// idx 是字节位置，做一次近似换算
	start := 0
	if idx > 40 {
		start = idx - 40
	}
	for start > 0 && start < len(text) && !isRuneBoundary(text, start) {
		start--
	}
	end := idx + qlen + 60
	if end > len(text) {
		end = len(text)
	}
	for end < len(text) && !isRuneBoundary(text, end) {
		end++
	}
	s := strings.TrimSpace(text[start:end])
	if start > 0 {
		s = "…" + s
	}
	if end < len(text) {
		s += "…"
	}
	_ = runes
	return strings.ReplaceAll(s, "\n", " ")
}

func isRuneBoundary(s string, i int) bool { return utf8Start(s[i]) }

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// ---------------------------------------------------------------- 资源

// AssetPath 返回资源文件的绝对路径（防止路径穿越）。
// 先查工作区 assets/（上传与导入落这里，对应思源的 /assets/ 模式），
// 再逐个笔记本 assets/（思源默认把资源放在笔记本目录里，直接拿一份思源 data/ 过来也能用）。
func (s *Store) AssetPath(name string) (string, bool) {
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if base == "." || base == ".." || base == "/" || base == "" {
		return "", false
	}
	candidates := []string{filepath.Join(s.AssetsDir(), base)}
	if entries, err := os.ReadDir(s.DataDir()); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				candidates = append(candidates, filepath.Join(s.DataDir(), e.Name(), "assets", base))
			}
		}
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	return "", false
}

// SaveAsset 保存上传/导入的资源，返回相对引用（assets/xxx）。
// 文件名沿用思源的 <原名>-<yyyymmddHHmmSS>-<7 位随机>.<ext>：
// 同名文件不会互相覆盖（否则后传的会顶掉前一张图，引用它的文档就串图了）。
func (s *Store) SaveAsset(name string, data []byte) (string, error) {
	if err := os.MkdirAll(s.AssetsDir(), 0o755); err != nil {
		return "", err
	}
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	ext := strings.ToLower(filepath.Ext(base))
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	stem = safeAssetStem(stem)
	if stem == "" {
		stem = "asset"
	}
	base = stem + "-" + time.Now().Format("20060102150405") + "-" + siyuan.RandStr(7) + ext
	dest := filepath.Join(s.AssetsDir(), base)
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return "", err
	}
	return "assets/" + base, nil
}

// ImportAsset 导入已有工作区里的资源：**能沿用原文件名就沿用**。
//
// 文档里的图片引用是相对路径 assets/xxx.png，导入时若把文件名改成
// xxx-<时间戳>-<随机串>.png，文档就会指不到图（图片全 404）。所以只有目标
// 名下已经有同名文件时，才退回到 SaveAsset 的改名方案，避免覆盖已有图片；
// 改名后的新引用由调用方（importer）回写进文档。
func (s *Store) ImportAsset(name string, data []byte) (string, error) {
	if err := os.MkdirAll(s.AssetsDir(), 0o755); err != nil {
		return "", err
	}
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	ext := strings.ToLower(filepath.Ext(base))
	stem := safeAssetStem(strings.TrimSuffix(base, filepath.Ext(base)))
	if stem == "" {
		stem = "asset"
	}
	kept := stem + ext
	dest := filepath.Join(s.AssetsDir(), kept)
	if _, err := os.Stat(dest); os.IsNotExist(err) {
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return "", err
		}
		return "assets/" + kept, nil
	}
	return s.SaveAsset(base, data)
}

// safeAssetStem 把文件名里不能安全出现在 URL / 文件系统里的字符换掉，保留中文与常见符号。
func safeAssetStem(stem string) string {
	var b strings.Builder
	for _, r := range stem {
		switch {
		case r == '\uFFFD' || r < 0x20 || r == 0x7f:
			continue
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case strings.ContainsRune("-_.()[] ", r):
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := strings.TrimSpace(b.String())
	// Windows 不允许文件名以点结尾；纯空白也当不存在
	out = strings.Trim(out, ".")
	if len([]rune(out)) > 60 {
		out = string([]rune(out)[:60])
	}
	return out
}

// ---------------------------------------------------------------- 统计

type Stats struct {
	Notebooks int `json:"notebooks"`
	Docs      int `json:"docs"`
	Blocks    int `json:"blocks"`
	Chars     int `json:"chars"`
	Assets    int `json:"assets"`
}

// Stat 统计工作区内容。
func (s *Store) Stat() Stats {
	st := Stats{}
	nbs, _ := s.Notebooks()
	st.Notebooks = len(nbs)
	for _, ref := range s.AllDocs() {
		st.Docs++
		raw, err := os.ReadFile(ref.Path)
		if err != nil {
			continue
		}
		doc, err := siyuan.Parse(raw)
		if err != nil {
			continue
		}
		st.Blocks += len(doc.Children)
		for _, b := range doc.Children {
			st.Chars += len([]rune(b.Text()))
		}
	}
	if entries, err := os.ReadDir(s.AssetsDir()); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				st.Assets++
			}
		}
	}
	// 思源默认把资源放在各笔记本的 assets/ 里，一并统计
	if boxes, err := os.ReadDir(s.DataDir()); err == nil {
		for _, b := range boxes {
			if !b.IsDir() {
				continue
			}
			if entries, err := os.ReadDir(filepath.Join(s.DataDir(), b.Name(), "assets")); err == nil {
				for _, e := range entries {
					if !e.IsDir() {
						st.Assets++
					}
				}
			}
		}
	}
	return st
}
