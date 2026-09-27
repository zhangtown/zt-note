// Package server 提供 HTTP 接口与前端静态资源。
package server

import (
	"archive/zip"
	"bytes"
	"context"
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
	"sync"
	"time"

	"ztnote/internal/importer"
	"ztnote/internal/siyuan"
	"ztnote/internal/store"
	"ztnote/internal/users"
	"ztnote/internal/webui"
)

// Server 是 HTTP 服务。
//
// 一个进程服务多个用户：每个请求按网关身份头（X-Trim-Userid）分辨身份，
// 各自使用 <dataRoot>/users/<uid>/workspace 这份独立工作区，互不可见。
type Server struct {
	Users    users.Root
	Prefix   string // 网关前缀，例如 /app/zt-note
	Version  string
	Log      *log.Logger
	Sessions *SessionManager

	mu     sync.Mutex
	stores map[string]*store.Store

	static fs.FS
}

// New 创建服务；dataRoot 是应用数据根目录（通常是 $TRIM_PKGVAR）。
func New(dataRoot, prefix, version string, logger *log.Logger) *Server {
	s := &Server{
		Users:   users.NewRoot(dataRoot),
		Prefix:  prefix,
		Version: version,
		Log:     logger,
		stores:  map[string]*store.Store{},
	}
	s.Sessions = NewSessionManager(func(uid string) string { return s.Users.PinFile(uid) })
	if f, err := webui.FS(); err == nil {
		s.static = f
	}
	return s
}

// Handler 返回带前缀剥离的处理器。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// 公开接口：不涉及任何笔记数据
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/session", s.handleSession)
	mux.HandleFunc("/api/pin/setup", s.handlePinSetup)
	mux.HandleFunc("/api/pin/unlock", s.handlePinUnlock)
	mux.HandleFunc("/api/pin/lock", s.handlePinLock)
	mux.HandleFunc("/api/pin/change", s.handlePinChange)
	mux.HandleFunc("/api/pin/revoke", s.handlePinRevoke)

	// 数据接口：未解锁一律 401（由 guard 按 needsUnlock 判断）
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
	return s.stripPrefix(s.identify(s.logRequests(s.guard(mux))))
}

// ---------------------------------------------------------------- 中间件

// needsUnlock 判断路径是否需要「已解锁」才能访问。
// 除健康检查、会话信息与 PIN 入口外，/api/ 与 /assets/ 一律要解锁：
// 未解锁时连标题、搜索结果、图片都不下发。
func needsUnlock(p string) bool {
	switch p {
	case "/api/health", "/api/session", "/api/pin/setup", "/api/pin/unlock", "/api/pin/lock":
		return false
	}
	return strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/assets/")
}

// 身份放在请求上下文里（identify → 各 handler）。
type ctxKey int

const identityKey ctxKey = iota

// identify 解析网关身份头并放进请求上下文。
func (s *Server) identify(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := users.Parse(
			r.Header.Get(users.HeaderUID),
			r.Header.Get(users.HeaderName),
			r.Header.Get(users.HeaderAdmin),
		)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey, id)))
	})
}

// identity 取当前请求的用户身份（中间件没跑时回落 local）。
func identity(r *http.Request) users.Identity {
	if id, ok := r.Context().Value(identityKey).(users.Identity); ok {
		return id
	}
	return users.Parse("", "", "")
}

// guard 实施 PIN 门：没解锁的请求拿不到任何笔记数据。
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !needsUnlock(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		id := identity(r)
		if !s.Sessions.Lookup(sessionToken(r), id.UID) {
			fail(w, http.StatusUnauthorized, "locked")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Log != nil && !strings.HasPrefix(r.URL.Path, "/assets/") {
			s.Log.Printf("%s %s user=%s", r.Method, r.URL.String(), identity(r).UID)
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

// write 包装写操作：只允许 POST（能不能写由 guard 的解锁状态决定，
// 写的是谁的数据由身份头决定——每个用户写自己的工作区）。
func (s *Server) write(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, "只支持 POST")
			return
		}
		h(w, r)
	}
}

// ---------------------------------------------------------------- 工作区

// openStore 打开（必要时创建）某个用户的工作区。
func (s *Server) openStore(uid string) (*store.Store, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, ok := s.stores[uid]; ok {
		return st, nil
	}
	ws, err := s.Users.Ensure(uid)
	if err != nil {
		return nil, err
	}
	st := store.New(ws)
	if err := st.Ensure(); err != nil {
		return nil, err
	}
	s.stores[uid] = st
	return st, nil
}

// store 返回当前请求用户的工作区；失败时已写好 500，返回 nil。
func (s *Server) store(w http.ResponseWriter, r *http.Request) *store.Store {
	id := identity(r)
	st, err := s.openStore(id.UID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "打开工作区失败: "+err.Error())
		return nil
	}
	return st
}

// userJSON 是身份对外的 JSON 形态。
func userJSON(id users.Identity) map[string]any {
	return map[string]any{
		"uid":     id.UID,
		"name":    id.Display(),
		"isAdmin": id.IsAdmin,
		"local":   id.Local,
	}
}

// ---------------------------------------------------------------- 基础接口

// handleHealth 是健康检查（不涉及笔记数据，允许未解锁访问）。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	id := identity(r)
	locked := !s.Sessions.Lookup(sessionToken(r), id.UID)
	rec := map[string]any{
		"version":  s.Version,
		"dataRoot": s.Users.Base,
		"prefix":   s.Prefix,
		"frontend": webui.Available(),
		"user":     userJSON(id),
		"needsPin": s.Sessions.NeedsSetup(id.UID),
		"locked":   locked,
		"users":    len(s.Users.List()),
	}
	if !locked {
		if st, err := s.openStore(id.UID); err == nil {
			rec["dataDir"] = st.Root
			rec["stats"] = st.Stat()
		}
	}
	ok(w, rec)
}

// handleSession 返回当前身份与 PIN 状态，前端据此决定先显示哪一屏。
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	id := identity(r)
	locked := !s.Sessions.Lookup(sessionToken(r), id.UID)
	rec := map[string]any{
		"version":    s.Version,
		"prefix":     s.Prefix,
		"user":       userJSON(id),
		"needsSetup": s.Sessions.NeedsSetup(id.UID),
		"locked":     locked,
		"hasLibrary": s.Users.HasWorkspace(id.UID),
	}
	if !locked {
		rec["sessions"] = s.Sessions.CountFor(id.UID)
		if exp, ok := s.Sessions.Expires(sessionToken(r), id.UID); ok {
			rec["sessionExpiresAt"] = exp.UTC().Format(time.RFC3339)
		}
		if st, err := s.openStore(id.UID); err == nil {
			rec["dataDir"] = st.Root
			rec["stats"] = st.Stat()
		}
	}
	ok(w, rec)
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	st := s.store(w, r)
	if st == nil {
		return
	}
	nbs, err := st.Notebooks()
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	d, err := st.Detail(box, id)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	ok(w, d)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	st := s.store(w, r)
	if st == nil {
		return
	}
	hits := st.Search(q, limit)
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	d, err := st.SaveBlocks(req.Box, req.ID, req.Blocks)
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	meta, err := st.CreateDoc(req.Box, req.Title, req.ParentID)
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	if err := st.Rename(body.Box, id, body.Title); err != nil {
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	if err := st.Delete(body.Box, body.ID); err != nil {
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	id, err := st.CreateNotebook(body.Name)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"id": id, "name": body.Name})
}

// ---------------------------------------------------------------- 导入导出

func (s *Server) handleImportUpload(w http.ResponseWriter, r *http.Request) {
	st := s.store(w, r)
	if st == nil {
		return
	}
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
		res, err := importer.ImportZip(st, zr)
		if err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		ok(w, res)
		return
	}
	// 单个 .md 文件
	res, err := importer.ImportMarkdownBytes(st, header.Filename, data)
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	res, err := importer.ImportDir(st, strings.TrimSpace(body.Path))
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	setDownload(w, name)
	if err := importer.ExportSiyuan(st, box, w); err != nil {
		s.Log.Printf("导出失败: %v", err)
	}
}

func (s *Server) handleExportMarkdown(w http.ResponseWriter, r *http.Request) {
	box := r.URL.Query().Get("box")
	st := s.store(w, r)
	if st == nil {
		return
	}
	setDownload(w, "zt-note-markdown.zip")
	if err := importer.ExportMarkdown(st, box, w); err != nil {
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	ref, err := st.SaveAsset(header.Filename, data)
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
	st := s.store(w, r)
	if st == nil {
		return
	}
	p, okp := st.AssetPath(name)
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
