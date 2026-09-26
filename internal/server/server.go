// Package server 提供 HTTP 接口与前端静态资源。
package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"ztnote/internal/importer"
	"ztnote/internal/siyuan"
	"ztnote/internal/store"
	"ztnote/internal/webui"
)

// Server 是 HTTP 服务。
type Server struct {
	Store   *store.Store
	Prefix  string // 网关前缀，例如 /app/zt-note
	Version string
	Log     *log.Logger
	static  fs.FS
}

// New 创建服务。
func New(st *store.Store, prefix, version string, logger *log.Logger) *Server {
	s := &Server{Store: st, Prefix: prefix, Version: version, Log: logger}
	if f, err := webui.FS(); err == nil {
		s.static = f
	}
	return s
}

// Handler 返回带前缀剥离的处理器。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/tree", s.handleTree)
	mux.HandleFunc("/api/doc", s.handleDoc)
	mux.HandleFunc("/api/doc/save", s.write(s.handleDocSave))
	mux.HandleFunc("/api/doc/create", s.write(s.handleDocCreate))
	mux.HandleFunc("/api/doc/rename", s.write(s.handleDocRename))
	mux.HandleFunc("/api/doc/delete", s.write(s.handleDocDelete))
	mux.HandleFunc("/api/notebook/create", s.write(s.handleNotebookCreate))
	mux.HandleFunc("/api/search", s.handleSearch)
	mux.HandleFunc("/api/import/upload", s.write(s.handleImportUpload))
	mux.HandleFunc("/api/import/path", s.write(s.handleImportPath))
	mux.HandleFunc("/api/export/siyuan", s.handleExportSiyuan)
	mux.HandleFunc("/api/export/md", s.handleExportMarkdown)
	mux.HandleFunc("/api/assets/upload", s.write(s.handleAssetUpload))
	mux.HandleFunc("/assets/", s.handleAsset)
	mux.HandleFunc("/", s.handleStatic)
	return s.stripPrefix(s.logRequests(mux))
}

// ---------------------------------------------------------------- 中间件

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Log != nil && !strings.HasPrefix(r.URL.Path, "/assets/") {
			s.Log.Printf("%s %s", r.Method, r.URL.String())
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) stripPrefix(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if s.Prefix != "" && p != s.Prefix && strings.HasPrefix(p, s.Prefix+"/") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = strings.TrimPrefix(p, s.Prefix)
			next.ServeHTTP(w, r2)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// write 包装写操作：校验管理员身份。
func (s *Server) write(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, "只支持 POST")
			return
		}
		admin := r.Header.Get("X-Trim-Isadmin")
		if admin != "" && admin != "true" {
			fail(w, http.StatusForbidden, "需要管理员权限（当前帐号无写权限）")
			return
		}
		h(w, r)
	}
}

// ---------------------------------------------------------------- 基础接口

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	st := s.Store.Stat()
	ok(w, map[string]any{
		"version":  s.Version,
		"dataDir":  s.Store.Root,
		"prefix":   s.Prefix,
		"stats":    st,
		"frontend": webui.Available(),
	})
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	nbs, err := s.Store.Notebooks()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"notebooks": nbs})
}

func (s *Server) handleDoc(w http.ResponseWriter, r *http.Request) {
	box := r.URL.Query().Get("box")
	id := r.URL.Query().Get("id")
	if box == "" || id == "" {
		fail(w, http.StatusBadRequest, "缺少 box 或 id 参数")
		return
	}
	d, err := s.Store.Detail(box, id)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	ok(w, d)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	hits := s.Store.Search(q, limit)
	ok(w, map[string]any{"hits": hits, "query": q})
}

// ---------------------------------------------------------------- 写接口

type saveReq struct {
	Box    string           `json:"box"`
	ID     string           `json:"id"`
	Blocks []siyuan.BlockIn `json:"blocks"`
}

func (s *Server) handleDocSave(w http.ResponseWriter, r *http.Request) {
	var req saveReq
	if !decode(w, r, &req) {
		return
	}
	if req.Box == "" || req.ID == "" {
		fail(w, http.StatusBadRequest, "缺少 box 或 id")
		return
	}
	d, err := s.Store.SaveBlocks(req.Box, req.ID, req.Blocks)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, d)
}

type createReq struct {
	Box      string `json:"box"`
	Title    string `json:"title"`
	ParentID string `json:"parentId"`
}

func (s *Server) handleDocCreate(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if !decode(w, r, &req) {
		return
	}
	if req.Box == "" {
		fail(w, http.StatusBadRequest, "缺少 box")
		return
	}
	meta, err := s.Store.CreateDoc(req.Box, req.Title, req.ParentID)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, meta)
}

func (s *Server) handleDocRename(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Box   string `json:"box"`
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if !decode(w, r, &body) {
		return
	}
	id := body.ID
	if id == "" {
		id = r.URL.Query().Get("id")
	}
	if body.Box == "" || id == "" {
		fail(w, http.StatusBadRequest, "缺少 box 或 id")
		return
	}
	if err := s.Store.Rename(body.Box, id, body.Title); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"id": id, "title": body.Title})
}

func (s *Server) handleDocDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Box string `json:"box"`
		ID  string `json:"id"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Box == "" || body.ID == "" {
		fail(w, http.StatusBadRequest, "缺少 box 或 id")
		return
	}
	if err := s.Store.Delete(body.Box, body.ID); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"deleted": body.ID})
}

func (s *Server) handleNotebookCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	id, err := s.Store.CreateNotebook(body.Name)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"id": id, "name": body.Name})
}

// ---------------------------------------------------------------- 导入导出

func (s *Server) handleImportUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		fail(w, http.StatusBadRequest, "解析上传失败: "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, http.StatusBadRequest, "缺少 file 字段")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	name := strings.ToLower(header.Filename)
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			fail(w, http.StatusBadRequest, "不是有效的 zip: "+err.Error())
			return
		}
		res, err := importer.ImportZip(s.Store, zr)
		if err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		ok(w, res)
		return
	}
	// 单个 .md 文件
	res, err := importer.ImportMarkdownBytes(s.Store, header.Filename, data)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, res)
}

func (s *Server) handleImportPath(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Path) == "" {
		fail(w, http.StatusBadRequest, "缺少 path")
		return
	}
	res, err := importer.ImportDir(s.Store, strings.TrimSpace(body.Path))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, res)
}

func (s *Server) handleExportSiyuan(w http.ResponseWriter, r *http.Request) {
	box := r.URL.Query().Get("box")
	name := "zt-note-siyuan.zip"
	if box != "" && box != "all" {
		name = "zt-note-" + box + ".sy.zip"
	}
	setDownload(w, name)
	if err := importer.ExportSiyuan(s.Store, box, w); err != nil {
		s.Log.Printf("导出失败: %v", err)
	}
}

func (s *Server) handleExportMarkdown(w http.ResponseWriter, r *http.Request) {
	box := r.URL.Query().Get("box")
	setDownload(w, "zt-note-markdown.zip")
	if err := importer.ExportMarkdown(s.Store, box, w); err != nil {
		s.Log.Printf("导出失败: %v", err)
	}
}

func (s *Server) handleAssetUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, http.StatusBadRequest, "缺少 file 字段")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ref, err := s.Store.SaveAsset(header.Filename, data)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"name": path.Base(ref), "url": ref})
}

// ---------------------------------------------------------------- 静态资源

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/assets/")
	if name == "" {
		fail(w, http.StatusNotFound, "not found")
		return
	}
	if decoded, err := url.PathUnescape(name); err == nil {
		name = decoded
	}
	p, okp := s.Store.AssetPath(name)
	if !okp {
		fail(w, http.StatusNotFound, "资源不存在")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if s.static == nil {
		http.Error(w, "前端资源未构建", http.StatusInternalServerError)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if f, err := s.static.Open(p); err == nil {
		f.Close()
		if ct := mime.TypeByExtension(path.Ext(p)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		http.ServeFileFS(w, r, s.static, p)
		return
	}
	// SPA 回退
	http.ServeFileFS(w, r, s.static, "index.html")
}

// ---------------------------------------------------------------- 工具

// ok 输出 {"ok":true, ...} 扁平 JSON（结构体也会展开为对象字段）。
func ok(w http.ResponseWriter, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	m := map[string]any{}
	if err := json.Unmarshal(raw, &m); err != nil {
		m = map[string]any{"data": json.RawMessage(raw)}
	}
	m["ok"] = true
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(m)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		fail(w, http.StatusBadRequest, "读取请求失败")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		fail(w, http.StatusBadRequest, "请求体为空")
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		fail(w, http.StatusBadRequest, "JSON 解析失败: "+err.Error())
		return false
	}
	return true
}

func setDownload(w http.ResponseWriter, filename string) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8''%s", filename, url.PathEscape(filename)))
}
