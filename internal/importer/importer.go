// Package importer 负责 zip / 服务器目录的导入与导出。
//
// 自动识别两种格式：
//  1. 思源格式：zip 或目录里含 *.sy（可以是思源工作区 data 目录、单个笔记本或任意前缀）
//  2. Markdown 格式：含 *.md（markdown-export 结构：<笔记本>/<标题>.md + assets/）
package importer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"ztnote/internal/siyuan"
	"ztnote/internal/store"
)

// Result 是导入结果摘要。
type Result struct {
	Format    string   `json:"format"` // siyuan | markdown
	Notebooks []string `json:"notebooks"`
	Docs      int      `json:"docs"`
	Assets    int      `json:"assets"`
	Notes     []string `json:"notes,omitempty"`
}

// Loader 抽象“一批命名文件”（zip 或磁盘目录）。
type Loader interface {
	Names() []string
	Read(name string) (io.ReadCloser, error)
}

// ---------------------------------------------------------------- zip / dir

type zipLoader struct{ r *zip.Reader }

func (z zipLoader) Names() []string {
	out := make([]string, 0, len(z.r.File))
	for _, f := range z.r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		out = append(out, path.Clean(strings.TrimPrefix(f.Name, "./")))
	}
	return out
}

func (z zipLoader) Read(name string) (io.ReadCloser, error) {
	for _, f := range z.r.File {
		if path.Clean(strings.TrimPrefix(f.Name, "./")) == name {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("zip 中没有 %s", name)
}

type dirLoader struct{ root string }

func (d dirLoader) Names() []string {
	var out []string
	_ = filepath.Walk(d.root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.root, p)
		if err != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(out)
	return out
}

func (d dirLoader) Read(name string) (io.ReadCloser, error) {
	clean := path.Clean(name)
	if strings.Contains(clean, "..") {
		return nil, fmt.Errorf("非法路径: %s", name)
	}
	return os.Open(filepath.Join(d.root, filepath.FromSlash(clean)))
}

// ImportZip 从 zip 导入。
func ImportZip(s *store.Store, r *zip.Reader) (*Result, error) {
	names := zipLoader{r}.Names()
	if len(names) == 1 && strings.HasSuffix(names[0], "/") {
		return nil, fmt.Errorf("压缩包为空")
	}
	return Import(s, zipLoader{r})
}

// ImportDir 从服务器本地目录导入。
func ImportDir(s *store.Store, dir string) (*Result, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("目录不存在: %s", dir)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("不是目录: %s", dir)
	}
	return Import(s, dirLoader{dir})
}

// ImportMarkdownBytes 导入单个 .md 文件（整篇作为一篇文档；若识别为汇总文件则拆分）。
func ImportMarkdownBytes(s *store.Store, filename string, data []byte) (*Result, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if err := addBytesToZip(zw, path.Base(filename), data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		return nil, err
	}
	return ImportZip(s, zr)
}

// Import 自动识别格式并导入。
func Import(s *store.Store, l Loader) (*Result, error) {
	names := l.Names()
	var syFiles, mdFiles []string
	for _, n := range names {
		switch {
		case strings.HasSuffix(strings.ToLower(n), ".sy"):
			syFiles = append(syFiles, n)
		case strings.HasSuffix(strings.ToLower(n), ".md"):
			mdFiles = append(mdFiles, n)
		}
	}
	switch {
	case len(syFiles) > 0:
		return importSiyuan(s, l, names, syFiles)
	case len(mdFiles) > 0:
		return importMarkdown(s, l, names, mdFiles)
	default:
		return nil, fmt.Errorf("没有找到 .sy 或 .md 文件，无法识别格式")
	}
}

// ---------------------------------------------------------------- 思源格式

var assetDirRe = regexp.MustCompile(`(^|/)assets/`)

func importSiyuan(s *store.Store, l Loader, names, syFiles []string) (*Result, error) {
	res := &Result{Format: "siyuan"}
	boxMap := map[string]string{}   // 原始 key → 实际 boxID
	boxNames := map[string]string{} // boxID → 显示名

	// 1. 先读 .siyuan/conf.json 拿笔记本名
	for _, n := range names {
		base := path.Base(n)
		if base != "conf.json" || !strings.Contains(n, ".siyuan/") {
			continue
		}
		dir := path.Dir(path.Dir(n)) // 去掉 .siyuan/conf.json
		key := path.Base(dir)
		raw, err := readAll(l, n)
		if err != nil {
			continue
		}
		var conf map[string]any
		if json.Unmarshal(raw, &conf) != nil {
			continue
		}
		if name, ok := conf["name"].(string); ok && strings.TrimSpace(name) != "" {
			boxNames[key] = name
		}
	}

	// 2. 逐篇导入
	for _, n := range syFiles {
		raw, err := readAll(l, n)
		if err != nil {
			res.Notes = append(res.Notes, "读取失败: "+n)
			continue
		}
		doc, err := siyuan.Parse(raw)
		if err != nil {
			res.Notes = append(res.Notes, "解析失败: "+n)
			continue
		}
		parts := strings.Split(n, "/")
		docID := strings.TrimSuffix(parts[len(parts)-1], ".sy")
		boxKey, parent := "", ""
		boxIdx := -1
		for i := len(parts) - 2; i >= 0; i-- {
			if siyuan.IsBoxID(parts[i]) {
				boxKey, boxIdx = parts[i], i
				break
			}
		}
		if boxKey == "" && len(parts) >= 2 {
			boxKey, boxIdx = parts[0], 0
		}
		if boxIdx >= 0 && boxIdx < len(parts)-2 {
			parent = strings.Join(parts[boxIdx+1:len(parts)-1], "/")
		}
		if boxKey == "" {
			boxKey = "导入的笔记本"
		}
		box, ok := boxMap[boxKey]
		if !ok {
			display := boxNames[boxKey]
			if display == "" {
				display = boxKey
			}
			id, err := s.EnsureNotebook(boxKey, display)
			if err != nil {
				return nil, err
			}
			boxMap[boxKey] = id
			box = id
			boxNames[id] = display
			res.Notebooks = append(res.Notebooks, display)
		}
		if docID != "" && doc.ID != docID {
			doc.ID = docID
			doc.SetProp("id", docID)
		}
		if _, err := s.WriteDoc(box, doc, parent); err != nil {
			res.Notes = append(res.Notes, "写入失败: "+n)
			continue
		}
		res.Docs++
	}

	// 3. 资源文件
	for _, n := range names {
		if !assetDirRe.MatchString(n) {
			continue
		}
		rc, err := l.Read(n)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		if _, err := s.SaveAsset(path.Base(n), data); err != nil {
			continue
		}
		res.Assets++
	}
	return res, nil
}

// ---------------------------------------------------------------- Markdown 格式

func importMarkdown(s *store.Store, l Loader, names, mdFiles []string) (*Result, error) {
	res := &Result{Format: "markdown"}
	type pending struct {
		notebook string
		title    string
		body     string
	}
	var jobs []pending
	for _, n := range mdFiles {
		if assetDirRe.MatchString(n) || strings.HasPrefix(path.Base(n), ".") {
			continue
		}
		raw, err := readAll(l, n)
		if err != nil {
			res.Notes = append(res.Notes, "读取失败: "+n)
			continue
		}
		body := string(raw)
		if strings.Contains(body, "<!-- zt-note export index -->") {
			continue // 自己生成的索引文件
		}
		parts := strings.Split(n, "/")
		notebook := "导入的 Markdown"
		if len(parts) >= 2 {
			notebook = parts[0]
		}
		title := strings.TrimSuffix(path.Base(n), ".md")
		if h := firstHeading(body); h != "" {
			title = h
		}
		// 汇总文件：H1 = 笔记本，H2 = 文档
		if secs, ok := splitNotebookFile(body); ok {
			for nb, notes := range secs {
				for _, note := range notes {
					jobs = append(jobs, pending{notebook: nb, title: note.title, body: note.body})
				}
			}
			continue
		}
		jobs = append(jobs, pending{notebook: notebook, title: title, body: body})
	}

	boxMap := map[string]string{}
	for _, j := range jobs {
		box, ok := boxMap[j.notebook]
		if !ok {
			id, err := s.EnsureNotebook("", j.notebook)
			if err != nil {
				return nil, err
			}
			boxMap[j.notebook] = id
			res.Notebooks = append(res.Notebooks, j.notebook)
			box = id
		}
		doc := siyuan.MDToDoc(j.body, j.title, "")
		if _, err := s.WriteDoc(box, doc, ""); err != nil {
			res.Notes = append(res.Notes, "写入失败: "+j.title)
			continue
		}
		res.Docs++
	}

	// 资源
	for _, n := range names {
		if !assetDirRe.MatchString(n) {
			continue
		}
		rc, err := l.Read(n)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		if _, err := s.SaveAsset(path.Base(n), data); err != nil {
			continue
		}
		res.Assets++
	}
	return res, nil
}

type noteSection struct {
	title string
	body  string
}

// splitNotebookFile 识别「# 笔记本 / ## 文档」结构的汇总文件。
func splitNotebookFile(md string) (map[string][]noteSection, bool) {
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	type h1Section struct {
		title string
		lines []string
	}
	var sections []h1Section
	cur := -1
	for _, line := range lines {
		if strings.HasPrefix(line, "# ") {
			sections = append(sections, h1Section{title: strings.TrimSpace(line[2:])})
			cur++
			continue
		}
		if cur >= 0 {
			sections[cur].lines = append(sections[cur].lines, line)
		}
	}
	// 统计每个 H1 段里的 H2 数量
	withNotes := 0
	for _, sec := range sections {
		for _, l := range sec.lines {
			if strings.HasPrefix(l, "## ") {
				withNotes++
				break
			}
		}
	}
	if len(sections) < 2 || withNotes < 2 {
		return nil, false
	}
	out := map[string][]noteSection{}
	for _, sec := range sections {
		var notes []noteSection
		var curTitle string
		var body []string
		flush := func() {
			if curTitle != "" {
				notes = append(notes, noteSection{title: curTitle, body: strings.Join(body, "\n")})
			}
			body = nil
		}
		for _, l := range sec.lines {
			if strings.HasPrefix(l, "## ") {
				flush()
				curTitle = strings.TrimSpace(l[3:])
				continue
			}
			if curTitle != "" {
				body = append(body, l)
			}
		}
		flush()
		if len(notes) > 0 {
			out[sec.title] = notes
		}
	}
	return out, true
}

func firstHeading(md string) string {
	for _, line := range strings.Split(md, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "# ") {
			return strings.TrimSpace(t[2:])
		}
		if t != "" && !strings.HasPrefix(t, "<!--") {
			return ""
		}
	}
	return ""
}

func readAll(l Loader, name string) ([]byte, error) {
	rc, err := l.Read(name)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// ---------------------------------------------------------------- 导出

// ExportSiyuan 导出为思源格式 zip（解压后可直接覆盖思源工作区 data 目录）。
func ExportSiyuan(s *store.Store, box string, w io.Writer) error {
	zw := zip.NewWriter(w)
	defer zw.Close()
	boxes := []string{}
	if box == "" || box == "all" {
		nbs, err := s.Notebooks()
		if err != nil {
			return err
		}
		for _, nb := range nbs {
			boxes = append(boxes, nb.ID)
		}
	} else {
		boxes = append(boxes, box)
	}
	added := map[string]bool{}
	for _, b := range boxes {
		root := filepath.Join(s.DataDir(), b)
		err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(s.DataDir(), p)
			if err != nil {
				return nil
			}
			name := "data/" + filepath.ToSlash(rel)
			if added[name] {
				return nil
			}
			added[name] = true
			return addFileToZip(zw, name, p)
		})
		if err != nil {
			return err
		}
	}
	// 资源
	entries, err := os.ReadDir(s.AssetsDir())
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			p := filepath.Join(s.AssetsDir(), e.Name())
			name := "data/assets/" + e.Name()
			if added[name] {
				continue
			}
			added[name] = true
			if err := addFileToZip(zw, name, p); err != nil {
				return err
			}
		}
	}
	return nil
}

// ExportMarkdown 导出为 markdown-export 结构 zip（<笔记本>/<标题>.md + assets/）。
func ExportMarkdown(s *store.Store, box string, w io.Writer) error {
	zw := zip.NewWriter(w)
	defer zw.Close()
	nbs, err := s.Notebooks()
	if err != nil {
		return err
	}
	used := map[string]int{}
	for _, nb := range nbs {
		if box != "" && box != "all" && nb.ID != box {
			continue
		}
		var walk func(list []*store.DocMeta, folder string)
		walk = func(list []*store.DocMeta, folder string) {
			for _, m := range list {
				pathOnDisk, err := s.FindDoc(nb.ID, m.ID)
				if err != nil {
					continue
				}
				raw, err := os.ReadFile(pathOnDisk)
				if err != nil {
					continue
				}
				doc, err := siyuan.Parse(raw)
				if err != nil {
					continue
				}
				name := safeName(m.Title)
				if name == "" {
					name = m.ID
				}
				if n := used[folder+"/"+name]; n > 0 {
					used[folder+"/"+name] = n + 1
					name = fmt.Sprintf("%s-%d", name, n+1)
				} else {
					used[folder+"/"+name] = 1
				}
				content := siyuan.RenderDocMarkdown(doc)
				var sb strings.Builder
				fmt.Fprintf(&sb, "<!-- 最后更新: %s -->\n\n", siyuan.Updated(doc))
				fmt.Fprintf(&sb, "# %s\n\n", m.Title)
				sb.WriteString(content)
				_ = addBytesToZip(zw, filepath.ToSlash(filepath.Join(folder, name+".md")), []byte(sb.String()))
				walk(m.Children, folder)
			}
		}
		walk(nb.Docs, safeName(nb.Name))
		_ = addBytesToZip(zw, filepath.ToSlash(filepath.Join(safeName(nb.Name), "README.md")), []byte(indexMarkdown(nb)))
	}
	gotAssets := false
	if entries, err := os.ReadDir(s.AssetsDir()); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			gotAssets = true
			if err := addFileToZip(zw, "assets/"+e.Name(), filepath.Join(s.AssetsDir(), e.Name())); err != nil {
				return err
			}
		}
	}
	_ = gotAssets
	return nil
}

func indexMarkdown(nb *store.Notebook) string {
	var sb strings.Builder
	sb.WriteString("<!-- zt-note export index -->\n\n")
	fmt.Fprintf(&sb, "# 思源笔记导出：%s\n\n共 %d 篇笔记。本目录的 markdown 文件可直接被思源「导入 Markdown」使用。\n\n", nb.Name, nb.Count)
	var walk func(list []*store.DocMeta)
	walk = func(list []*store.DocMeta) {
		for _, m := range list {
			fmt.Fprintf(&sb, "- %s（%s）\n", m.Title, m.Updated)
			walk(m.Children)
		}
	}
	walk(nb.Docs)
	return sb.String()
}

func addFileToZip(zw *zip.Writer, name, pathOnDisk string) error {
	f, err := os.Open(pathOnDisk)
	if err != nil {
		return err
	}
	defer f.Close()
	fw, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(fw, f)
	return err
}

func addBytesToZip(zw *zip.Writer, name string, data []byte) error {
	fw, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = fw.Write(data)
	return err
}

var unsafeNameRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)

func safeName(s string) string {
	s = unsafeNameRe.ReplaceAllString(s, "_")
	return strings.TrimSpace(s)
}
