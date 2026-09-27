package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newTestManager(t *testing.T) (*SessionManager, string) {
	t.Helper()
	dir := t.TempDir()
	m := NewSessionManager(func(uid string) string { return filepath.Join(dir, uid, "pin.json") })
	return m, dir
}

func TestValidPIN(t *testing.T) {
	for _, ok := range []string{"000000", "135790", "999999"} {
		if !ValidPIN(ok) {
			t.Errorf("ValidPIN(%q) = false，期望 true", ok)
		}
	}
	for _, bad := range []string{"", "12345", "1234567", "abcdef", "12345a", " 123456", "123456\n"} {
		if ValidPIN(bad) {
			t.Errorf("ValidPIN(%q) = true，期望 false", bad)
		}
	}
}

func TestWeakPIN(t *testing.T) {
	for _, weak := range []string{"000000", "111111", "123456", "654321", "012345", "987654"} {
		if !WeakPIN(weak) {
			t.Errorf("WeakPIN(%q) = false，期望 true", weak)
		}
	}
	for _, strong := range []string{"135790", "204813", "192837", "528491"} {
		if WeakPIN(strong) {
			t.Errorf("WeakPIN(%q) = true，期望 false", strong)
		}
	}
	// 格式不对时不算弱口令（另由 ValidPIN 拦）
	if WeakPIN("12345") {
		t.Error("位数不对不该判定为弱口令")
	}
}

func TestSetPINAndVerify(t *testing.T) {
	m, dir := newTestManager(t)
	const uid = "1000"
	const pin = "135790"

	if !m.NeedsSetup(uid) {
		t.Fatal("新用户 NeedsSetup 应该是 true")
	}
	if _, err := m.VerifyPIN(uid, pin); err != ErrNoPIN {
		t.Fatalf("未设 PIN 时 VerifyPIN 应返回 ErrNoPIN，得到 %v", err)
	}
	if err := m.SetPIN(uid, "123"); err != ErrBadPIN {
		t.Fatalf("设置非 6 位 PIN 应返回 ErrBadPIN，得到 %v", err)
	}
	if err := m.SetPIN(uid, pin); err != nil {
		t.Fatalf("SetPIN: %v", err)
	}
	if m.NeedsSetup(uid) {
		t.Error("设置后 NeedsSetup 应该是 false")
	}
	if err := m.SetPIN(uid, "246810"); err != ErrHasPIN {
		t.Fatalf("重复设置应返回 ErrHasPIN，得到 %v", err)
	}
	if res, err := m.VerifyPIN(uid, pin); err != nil || !res.OK {
		t.Fatalf("正确 PIN 应通过，得到 %+v, %v", res, err)
	}

	// 连错 4 次：还剩 4/3/2/1 次
	for i, want := range []int{4, 3, 2, 1} {
		res, err := m.VerifyPIN(uid, "000001")
		if err != nil {
			t.Fatalf("第 %d 次错误校验报错: %v", i+1, err)
		}
		if res.OK || res.Remaining != want || res.LockFor != 0 {
			t.Fatalf("第 %d 次错误后应有 %d 次机会，得到 %+v", i+1, want, res)
		}
	}
	// 第 5 次错误 → 锁定 1 分钟
	res, err := m.VerifyPIN(uid, "000001")
	if err != nil {
		t.Fatalf("第 5 次错误校验报错: %v", err)
	}
	if res.OK || res.LockFor != time.Minute {
		t.Fatalf("第 5 次错误后应锁定 1 分钟，得到 %+v", res)
	}
	if got := m.LockedFor(uid); got <= 0 || got > time.Minute {
		t.Fatalf("LockedFor = %v，期望 (0,1m]", got)
	}
	// 锁定期间即使 PIN 正确也不放行
	if res, err := m.VerifyPIN(uid, pin); err != nil || res.OK || res.LockFor <= 0 {
		t.Fatalf("锁定期间应拒绝，得到 %+v, %v", res, err)
	}
	// 时间推进到锁定结束：正确 PIN 放行，计数清零
	m.now = func() time.Time { return time.Now().Add(61 * time.Second) }
	if res, err := m.VerifyPIN(uid, pin); err != nil || !res.OK {
		t.Fatalf("解锁后正确 PIN 应通过，得到 %+v, %v", res, err)
	}
	if got := m.LockedFor(uid); got != 0 {
		t.Fatalf("通过后不该还处于锁定，LockedFor = %v", got)
	}
	m.now = time.Now

	// PIN 文件：不含明文，只有盐与哈希
	raw, err := os.ReadFile(filepath.Join(dir, uid, "pin.json"))
	if err != nil {
		t.Fatalf("读 PIN 文件: %v", err)
	}
	if strings.Contains(string(raw), pin) {
		t.Fatalf("PIN 文件里出现了明文 PIN: %s", raw)
	}
	var rec pinRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("PIN 文件不是合法 JSON: %v", err)
	}
	if rec.Algo != pinAlgo || rec.Iters != pinIters || rec.Salt == "" || rec.Hash == "" {
		t.Errorf("PIN 记录字段不对: %+v", rec)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(filepath.Join(dir, uid, "pin.json"))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("PIN 文件权限 = %v，期望 0600", st.Mode().Perm())
		}
	}
}

func TestChangePIN(t *testing.T) {
	m, _ := newTestManager(t)
	const uid = "1000"
	if err := m.SetPIN(uid, "135790"); err != nil {
		t.Fatal(err)
	}
	if err := m.ChangePIN(uid, "135790", "12345"); err != ErrBadPIN {
		t.Errorf("新 PIN 位数不对应返回 ErrBadPIN，得到 %v", err)
	}
	if err := m.ChangePIN(uid, "999999", "246810"); err != ErrBadOld {
		t.Errorf("原 PIN 错误应返回 ErrBadOld，得到 %v", err)
	}
	if err := m.ChangePIN(uid, "135790", "246810"); err != nil {
		t.Fatalf("ChangePIN: %v", err)
	}
	if res, _ := m.VerifyPIN(uid, "246810"); !res.OK {
		t.Error("新 PIN 应该能用")
	}
	if res, _ := m.VerifyPIN(uid, "135790"); res.OK {
		t.Error("旧 PIN 不该还能用")
	}
}

func TestSessions(t *testing.T) {
	m, _ := newTestManager(t)
	token := m.Create("1000")
	if token == "" {
		t.Fatal("Create 返回空令牌")
	}
	if !m.Lookup(token, "1000") {
		t.Error("令牌应对 1000 有效")
	}
	// 令牌绑身份：换了网关注入的 uid 就不认
	if m.Lookup(token, "1001") {
		t.Error("令牌不该对别的 uid 有效")
	}
	if m.Lookup("", "1000") || m.Lookup("deadbeef", "1000") {
		t.Error("空令牌或不存在的令牌不该通过")
	}

	// 两个用户的会话互不影响
	other := m.Create("1001")
	m.DropUser("1000")
	if m.Lookup(token, "1000") {
		t.Error("DropUser 后令牌应失效")
	}
	if !m.Lookup(other, "1001") {
		t.Error("DropUser 不该影响别的用户")
	}
	m.Drop(other)
	if m.Lookup(other, "1001") {
		t.Error("Drop 后令牌应失效")
	}

	// 过期：滑动续期，但过期即失效
	tok2 := m.Create("1000")
	m.now = func() time.Time { return time.Now().Add(sessionTTL + time.Second) }
	if m.Lookup(tok2, "1000") {
		t.Error("过期令牌应失效")
	}
	m.now = time.Now
	tok3 := m.Create("1000")
	m.now = func() time.Time { return time.Now().Add(sessionTTL - time.Hour) }
	if !m.Lookup(tok3, "1000") {
		t.Error("未过期令牌应有效")
	}
	m.now = time.Now
}

func TestNeedsUnlockPaths(t *testing.T) {
	open := []string{"/api/health", "/api/session", "/api/pin/setup", "/api/pin/unlock", "/api/pin/lock", "/", "/index.html", "/static/app.js"}
	for _, p := range open {
		if needsUnlock(p) {
			t.Errorf("needsUnlock(%q) = true，期望 false（这些接口未解锁也要能用）", p)
		}
	}
	guarded := []string{"/api/tree", "/api/doc", "/api/doc/save", "/api/search", "/api/import/upload", "/api/export/siyuan", "/api/pin/change", "/assets/a.png"}
	for _, p := range guarded {
		if !needsUnlock(p) {
			t.Errorf("needsUnlock(%q) = false，期望 true（未解锁必须 401）", p)
		}
	}
}

func TestCookieHelpers(t *testing.T) {
	if cookiePath("") != "/" || cookiePath("/app/zt-note") != "/app/zt-note/" {
		t.Errorf("cookiePath: %q / %q", cookiePath(""), cookiePath("/app/zt-note"))
	}
	r := httptest.NewRequest(http.MethodPost, "/api/pin/unlock", nil)
	c := sessionCookie(r, cookiePath("/app/zt-note"), "tok", 3600)
	if c.Name != cookieName || !c.HttpOnly || c.Path != "/app/zt-note/" || c.MaxAge != 3600 {
		t.Errorf("Cookie 属性不对: %+v", c)
	}
	if c.Secure {
		t.Error("明文 HTTP 下不该标 Secure（否则内网 http 访问带不上 Cookie）")
	}
	r2 := httptest.NewRequest(http.MethodPost, "/api/pin/unlock", nil)
	r2.Header.Set("X-Forwarded-Proto", "https")
	if !sessionCookie(r2, "/", "tok", 1).Secure {
		t.Error("网关转发 https 时应标 Secure")
	}
}

// TestHTTPPinGate 用真实 Handler 走一遍「锁 → 设 PIN → 解锁 → 换身份 → 再锁」。
func TestHTTPPinGate(t *testing.T) {
	dataRoot := t.TempDir()
	srv := New(dataRoot, "", "test", log.New(io.Discard, "", 0))
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	const pin = "135790"

	do := func(method, path string, body string, uid string, cookie *http.Cookie) (*http.Response, map[string]any, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != "" {
			rdr = strings.NewReader(body)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if uid != "" {
			req.Header.Set("X-Trim-Userid", uid)
			req.Header.Set("X-Trim-Username", "u"+uid)
			req.Header.Set("X-Trim-Isadmin", "true")
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		rec := map[string]any{}
		_ = json.Unmarshal(raw, &rec)
		return resp, rec, raw
	}

	sessionCookieOf := func(resp *http.Response) *http.Cookie {
		for _, c := range resp.Cookies() {
			if c.Name == cookieName {
				return c
			}
		}
		return nil
	}

	// 1. 未解锁：数据接口 401，标题/图片都不下发
	for _, p := range []string{"/api/tree", "/api/search?q=%E4%B8%80", "/assets/none.png", "/api/export/siyuan?box=all", "/api/pin/change", "/api/pin/revoke"} {
		resp, _, raw := do(http.MethodGet, p, "", "", nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("未解锁访问 %s：status=%d body=%s，期望 401", p, resp.StatusCode, clipForTest(raw))
		}
		if !strings.Contains(string(raw), "locked") {
			t.Errorf("未解锁访问 %s 的响应缺少 locked 提示: %s", p, clipForTest(raw))
		}
	}

	// 2. 会话接口可用，且报告「没设 PIN」
	resp, rec, _ := do(http.MethodGet, "/api/session", "", "", nil)
	if resp.StatusCode != 200 || rec["needsSetup"] != true || rec["locked"] != true {
		t.Fatalf("api/session = %d %v，期望 needsSetup/locked 均为 true", resp.StatusCode, rec)
	}
	if user, _ := rec["user"].(map[string]any); user == nil || user["uid"] != "local" {
		t.Errorf("无身份头时应回落 local，得到 %v", rec["user"])
	}

	// 3. 位数不够 → 400
	if resp, _, _ := do(http.MethodPost, "/api/pin/setup", `{"pin":"123"}`, "", nil); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("弱位数 PIN 应 400，得到 %d", resp.StatusCode)
	}

	// 4. 设置 PIN → 200 + Cookie + onboarded
	resp, rec, raw := do(http.MethodPost, "/api/pin/setup", `{"pin":"`+pin+`"}`, "", nil)
	if resp.StatusCode != 200 || rec["ok"] != true || rec["onboarded"] != true {
		t.Fatalf("api/pin/setup = %d %s", resp.StatusCode, clipForTest(raw))
	}
	ck := sessionCookieOf(resp)
	if ck == nil || ck.Value == "" {
		t.Fatal("设置 PIN 后没发会话 Cookie")
	}
	if !ck.HttpOnly {
		t.Error("会话 Cookie 应该是 HttpOnly")
	}

	// 5. 解锁后可读数据；首次进入自动送《我的笔记》与欢迎文档
	resp, rec, raw = do(http.MethodGet, "/api/tree", "", "", ck)
	if resp.StatusCode != 200 {
		t.Fatalf("解锁后 api/tree = %d %s", resp.StatusCode, clipForTest(raw))
	}
	books, _ := rec["notebooks"].([]any)
	if len(books) != 1 {
		t.Fatalf("首次进入应有 1 个笔记本，得到 %d：%s", len(books), clipForTest(raw))
	}
	first, _ := books[0].(map[string]any)
	if first["name"] != welcomeNotebook {
		t.Errorf("欢迎笔记本名 = %v，期望 %q", first["name"], welcomeNotebook)
	}
	docs, _ := first["docs"].([]any)
	if len(docs) != 1 {
		t.Fatalf("应有 1 篇欢迎文档，得到 %d", len(docs))
	}
	doc, _ := docs[0].(map[string]any)
	boxID, _ := first["id"].(string)
	resp, rec, raw = do(http.MethodGet, "/api/doc?box="+boxID+"&id="+doc["id"].(string), "", "", ck)
	if resp.StatusCode != 200 {
		t.Fatalf("读欢迎文档 = %d %s", resp.StatusCode, clipForTest(raw))
	}
	if html, _ := rec["html"].(string); !strings.Contains(html, "PIN") {
		t.Errorf("欢迎文档正文没读出来: %s", clipForTest(raw))
	}

	// 6. 同一个 Cookie 换身份 → 401（令牌与网关身份绑定）
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tree", nil)
	req.Header.Set("X-Trim-Userid", "1001")
	req.Header.Set("X-Trim-Username", "other")
	req.AddCookie(ck)
	respOther, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respOther.Body.Close()
	if respOther.StatusCode != http.StatusUnauthorized {
		t.Errorf("别人的 Cookie 不该能看 1000 的库，status=%d", respOther.StatusCode)
	}

	// 7. 另一个账号有自己的 PIN 空间与自己的库
	resp, rec, _ = do(http.MethodGet, "/api/session", "", "1001", nil)
	if resp.StatusCode != 200 || rec["needsSetup"] != true {
		t.Errorf("1001 应该是全新用户（needsSetup=true），得到 %d %v", resp.StatusCode, rec)
	}
	resp, rec, _ = do(http.MethodPost, "/api/pin/setup", `{"pin":"246810"}`, "1001", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("1001 设 PIN 失败: %d %v", resp.StatusCode, rec)
	}
	ck2 := sessionCookieOf(resp)
	resp, rec, raw = do(http.MethodGet, "/api/tree", "", "1001", ck2)
	if resp.StatusCode != 200 {
		t.Fatalf("1001 读自己的树失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	books2, _ := rec["notebooks"].([]any)
	if len(books2) != 1 {
		t.Fatalf("1001 应看到自己的 1 个笔记本，得到 %d", len(books2))
	}
	b2, _ := books2[0].(map[string]any)
	if b2["id"] == first["id"] {
		t.Error("两个用户的笔记本 ID 相同，说明数据没有隔离")
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "users", "local", "pin.json")); err != nil {
		t.Errorf("匿名（local）的 PIN 文件不在预期位置: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "users", "1001", "pin.json")); err != nil {
		t.Errorf("1001 的 PIN 文件不在预期位置: %v", err)
	}

	// 8. 锁定 → 401；错误 PIN → 401 带剩余次数；正确 PIN → 200 新 Cookie
	if resp, _, _ := do(http.MethodPost, "/api/pin/lock", `{}`, "", ck); resp.StatusCode != 200 {
		t.Errorf("api/pin/lock = %d", resp.StatusCode)
	}
	if resp, _, _ := do(http.MethodGet, "/api/tree", "", "", ck); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("锁定后 api/tree = %d，期望 401", resp.StatusCode)
	}
	resp, rec, _ = do(http.MethodPost, "/api/pin/unlock", `{"pin":"000001"}`, "", nil)
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(asString(rec["error"]), "还能试") {
		t.Errorf("错误 PIN 应 401 并提示剩余次数，得到 %d %v", resp.StatusCode, rec)
	}
	resp, rec, raw = do(http.MethodPost, "/api/pin/unlock", `{"pin":"`+pin+`"}`, "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("正确 PIN 解锁失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	ck3 := sessionCookieOf(resp)
	if ck3 == nil {
		t.Fatal("解锁后没发新 Cookie")
	}
	if resp, _, _ := do(http.MethodGet, "/api/tree", "", "", ck3); resp.StatusCode != 200 {
		t.Errorf("解锁后 api/tree = %d，期望 200", resp.StatusCode)
	}

	// 9. 改 PIN：原 PIN 错 → 401；成功 → 旧会话全失效
	if resp, _, _ := do(http.MethodPost, "/api/pin/change", `{"old":"999999","new":"528491"}`, "", ck3); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("改 PIN 原码错应 401，得到 %d", resp.StatusCode)
	}
	resp, rec, raw = do(http.MethodPost, "/api/pin/change", `{"old":"`+pin+`","new":"528491"}`, "", ck3)
	if resp.StatusCode != 200 {
		t.Fatalf("改 PIN 失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	if resp, _, _ := do(http.MethodGet, "/api/tree", "", "", ck3); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("改 PIN 后旧会话应失效，得到 %d", resp.StatusCode)
	}
	if resp, _, _ := do(http.MethodPost, "/api/pin/unlock", `{"pin":"528491"}`, "", nil); resp.StatusCode != 200 {
		t.Errorf("新 PIN 应能解锁，得到 %d", resp.StatusCode)
	}

	// 10. 数据落在 users/<uid>/workspace 里
	for _, uid := range []string{"local", "1001"} {
		if _, err := os.Stat(filepath.Join(dataRoot, "users", uid, "workspace", "data")); err != nil {
			t.Errorf("uid %s 的工作区不存在: %v", uid, err)
		}
	}
}

// TestSessionCountAndExpiry 卡住「会话计数 / 到期时间 / 批量注销」的语义：
// PIN 管理页要显示「本账号还有几处已解锁」和「本次解锁什么时候到期」。
func TestSessionCountAndExpiry(t *testing.T) {
	m, _ := newTestManager(t)
	if err := m.SetPIN("1000", "135790"); err != nil {
		t.Fatal(err)
	}
	a1, a2, b1 := m.Create("1000"), m.Create("1000"), m.Create("2000")
	if a1 == "" || a2 == "" || b1 == "" {
		t.Fatal("Create 应返回非空令牌")
	}
	if n := m.CountFor("1000"); n != 2 {
		t.Errorf("CountFor(1000) = %d，期望 2", n)
	}
	if n := m.CountFor("2000"); n != 1 {
		t.Errorf("CountFor(2000) = %d，期望 1", n)
	}
	if n := m.CountFor("9999"); n != 0 {
		t.Errorf("CountFor(9999) = %d，期望 0", n)
	}
	if _, ok := m.Expires(a1, "1000"); !ok {
		t.Error("Expires 应认得本用户的令牌")
	}
	if _, ok := m.Expires(a1, "2000"); ok {
		t.Error("Expires 不该把别人的令牌算给 2000")
	}
	if _, ok := m.Expires("nope", "1000"); ok {
		t.Error("Expires 对无效令牌应返回 false")
	}
	exp, _ := m.Expires(a1, "1000")
	if d := time.Until(exp); d < sessionTTL-2*time.Minute || d > sessionTTL {
		t.Errorf("到期时间应在 %v 量级，得到 %v", sessionTTL, d)
	}
	if n := m.DropUser("1000"); n != 2 {
		t.Errorf("DropUser 应注销 2 枚会话，得到 %d", n)
	}
	if n := m.CountFor("1000"); n != 0 {
		t.Errorf("DropUser 后 CountFor = %d，期望 0", n)
	}
	if m.Lookup(a1, "1000") || m.Lookup(a2, "1000") {
		t.Error("DropUser 后本用户令牌都应失效")
	}
	if !m.Lookup(b1, "2000") {
		t.Error("DropUser 不该影响别的用户")
	}
	if n := m.DropUser("9999"); n != 0 {
		t.Errorf("没会话的用户 DropUser 应得 0，得到 %d", n)
	}
}

// TestHTTPPinRevoke 走真实 HTTP：两台设备各解锁一次，其中一台「撤销其它设备」后
// 只剩发出请求的那台还能用，且会话数回到 1。
func TestHTTPPinRevoke(t *testing.T) {
	dataRoot := t.TempDir()
	srv := New(dataRoot, "", "test", log.New(io.Discard, "", 0))
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	do := func(method, path string, body string, cookie *http.Cookie) (*http.Response, map[string]any, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != "" {
			rdr = strings.NewReader(body)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("X-Trim-Userid", "1000")
		req.Header.Set("X-Trim-Username", "tester")
		req.Header.Set("X-Trim-Isadmin", "true")
		if cookie != nil {
			req.AddCookie(cookie)
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		rec := map[string]any{}
		_ = json.Unmarshal(raw, &rec)
		return resp, rec, raw
	}
	sessionCookieOf := func(resp *http.Response) *http.Cookie {
		for _, c := range resp.Cookies() {
			if c.Name == cookieName {
				return c
			}
		}
		return nil
	}

	const pin = "135790"
	// 设备 A：设置 PIN（同时拿到会话）
	resp, _, raw := do(http.MethodPost, "/api/pin/setup", `{"pin":"`+pin+`"}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("设置 PIN 失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	ckA := sessionCookieOf(resp)
	if ckA == nil {
		t.Fatal("设置 PIN 后应下发会话 Cookie")
	}
	// 设备 B：解锁
	resp, _, raw = do(http.MethodPost, "/api/pin/unlock", `{"pin":"`+pin+`"}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("设备 B 解锁失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	ckB := sessionCookieOf(resp)

	// 两台设备都能读数据，会话数为 2，且能问到到期时间
	for name, ck := range map[string]*http.Cookie{"A": ckA, "B": ckB} {
		if resp, _, raw := do(http.MethodGet, "/api/tree", "", ck); resp.StatusCode != 200 {
			t.Fatalf("设备 %s 读 /api/tree: %d %s", name, resp.StatusCode, clipForTest(raw))
		}
	}
	_, rec, _ := do(http.MethodGet, "/api/session", "", ckA)
	if n, _ := rec["sessions"].(float64); int(n) != 2 {
		t.Errorf("/api/session 的 sessions = %v，期望 2", rec["sessions"])
	}
	if s, _ := rec["sessionExpiresAt"].(string); s == "" {
		t.Error("/api/session 应带上本次解锁的到期时间")
	} else if _, err := time.Parse(time.RFC3339, s); err != nil {
		t.Errorf("到期时间应是 RFC3339，得到 %q", s)
	}

	// A 撤销其它设备：只该作废 B
	resp, rec, raw = do(http.MethodPost, "/api/pin/revoke", "", ckA)
	if resp.StatusCode != 200 {
		t.Fatalf("撤销失败: %d %s", resp.StatusCode, clipForTest(raw))
	}
	if n, _ := rec["revoked"].(float64); int(n) != 1 {
		t.Errorf("revoked = %v，期望 1（只作废 B）", rec["revoked"])
	}
	ckA2 := sessionCookieOf(resp)
	if ckA2 == nil {
		t.Fatal("撤销后当前设备应换到新会话")
	}
	if resp, _, _ := do(http.MethodGet, "/api/tree", "", ckB); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("B 的会话应作废，得到 %d", resp.StatusCode)
	}
	if resp, _, _ := do(http.MethodGet, "/api/tree", "", ckA); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("A 的旧会话也该作废（换了新令牌），得到 %d", resp.StatusCode)
	}
	if resp, _, raw := do(http.MethodGet, "/api/tree", "", ckA2); resp.StatusCode != 200 {
		t.Errorf("A 的新会话应可用: %d %s", resp.StatusCode, clipForTest(raw))
	}
	_, rec, _ = do(http.MethodGet, "/api/session", "", ckA2)
	if n, _ := rec["sessions"].(float64); int(n) != 1 {
		t.Errorf("撤销后 sessions = %v，期望 1", rec["sessions"])
	}

	// 再撤销一次：没有其它设备可撤，也应正常
	_, rec, _ = do(http.MethodPost, "/api/pin/revoke", "", ckA2)
	if n, _ := rec["revoked"].(float64); int(n) != 0 {
		t.Errorf("没有其它设备时 revoked = %v，期望 0", rec["revoked"])
	}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func clipForTest(b []byte) string {
	s := string(b)
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
