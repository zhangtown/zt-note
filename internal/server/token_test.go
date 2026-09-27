package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 会话令牌的「Cookie 之外」通道。
//
// 起因：飞牛 App 把应用嵌在 WebView 里，Cookie 可能存不下/不回传，
// 表现就是「PIN 输对了却一直要求重输」。所以令牌还要能从头和只读 URL 参数走。

type tokenHarness struct {
	t    *testing.T
	ts   *httptest.Server
	call func(method, path, body string, hdr map[string]string) (*http.Response, map[string]any, []byte)
}

func newTokenHarness(t *testing.T) *tokenHarness {
	t.Helper()
	dataRoot := t.TempDir()
	srv := New(dataRoot, "", "test", log.New(io.Discard, "", 0))
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	call := func(method, path, body string, hdr map[string]string) (*http.Response, map[string]any, []byte) {
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
		for k, v := range hdr {
			req.Header.Set(k, v)
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
	return &tokenHarness{t: t, ts: ts, call: call}
}

// uidHeader 造一个网关身份头。
func uidHeader(uid string) map[string]string {
	return map[string]string{
		"X-Trim-Userid":   uid,
		"X-Trim-Username": "u" + uid,
		"X-Trim-Isadmin":  "true",
	}
}

// withUID 把网关身份头与额外的一条头（例如 Authorization）合起来。
// key 写成 "Name: value" 的简化形式，省得每处都写 map。
func (h *tokenHarness) withUID(uid, extra string) map[string]string {
	hdr := uidHeader(uid)
	name, value, ok := strings.Cut(extra, ": ")
	if !ok {
		h.t.Fatalf("额外的头要写成 \"Name: value\"，得到 %q", extra)
	}
	hdr[name] = value
	return hdr
}

// unlockAs 设 PIN + 解锁，返回响应体里的令牌（客户端在 Cookie 存不住时用这个）。
func (h *tokenHarness) unlockAs(uid, pin string) string {
	h.t.Helper()
	resp, rec, raw := h.call(http.MethodPost, "/api/pin/setup", `{"pin":"`+pin+`"}`, uidHeader(uid))
	if resp.StatusCode != 200 {
		h.t.Fatalf("设置 PIN 失败：%d %s", resp.StatusCode, clipForTest(raw))
	}
	token := asString(rec["token"])
	if token == "" {
		h.t.Fatalf("解锁响应里没有 token（手机 App 就靠它）：%s", clipForTest(raw))
	}
	if c := resp.Cookies(); len(c) == 0 {
		h.t.Error("解锁响应还应该照旧下发 Cookie（浏览器里靠它，令牌不落到 JS 可读处）")
	}
	return token
}

// TestSessionResponseCarriesToken：解锁 / 改 PIN / 撤销都下发 token。
func TestSessionResponseCarriesToken(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")

	_, rec, raw := h.call(http.MethodPost, "/api/pin/change", `{"old":"135790","new":"246810"}`,
		h.withUID("1000", "Authorization: Bearer "+token))
	if newTok := asString(rec["token"]); newTok == "" || newTok == token {
		t.Fatalf("改 PIN 后应换一枚新令牌，得到 %q（旧令牌 %q）：%s", newTok, token, clipForTest(raw))
	}
	_, rec, raw = h.call(http.MethodPost, "/api/pin/revoke", "",
		h.withUID("1000", "Authorization: Bearer "+asString(rec["token"])))
	if asString(rec["token"]) == "" {
		t.Fatalf("撤销后应下发新令牌：%s", clipForTest(raw))
	}
}

// TestTokenHeaderChannels：完全不带 Cookie，仅凭请求头也能用（手机 App 场景）。
func TestTokenHeaderChannels(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")

	for _, hdr := range []map[string]string{
		{"Authorization": "Bearer " + token},
		{"X-Zt-Token": token},
		{"Authorization": "bearer " + token}, // 大小写不敏感
	} {
		hdr := hdr
		for k, v := range uidHeader("1000") {
			hdr[k] = v
		}
		resp, rec, raw := h.call(http.MethodGet, "/api/tree", "", hdr)
		if resp.StatusCode != 200 {
			t.Fatalf("仅凭 %v 应能读数据，得到 %d %s", hdr, resp.StatusCode, clipForTest(raw))
		}
		if _, ok := rec["notebooks"]; !ok {
			t.Fatalf("返回里应有 notebooks：%s", clipForTest(raw))
		}
		// /api/session 也要认
		if _, rec2, _ := h.call(http.MethodGet, "/api/session", "", hdr); rec2["locked"] != false {
			t.Fatalf("带头访问 /api/session 应为已解锁：%v", rec2)
		}
	}
}

// TestTokenQueryReadOnly：URL 参数只让只读请求通过（图片 / 导出下载没法加请求头），
// 写接口必须拒绝——否则一个链接就能借别人的令牌改数据。
func TestTokenQueryReadOnly(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")

	for _, path := range []string{
		"/api/tree?token=" + token,
		"/api/tree?t=" + token,
		"/api/session?t=" + token,
	} {
		resp, _, raw := h.call(http.MethodGet, path, "", uidHeader("1000"))
		if resp.StatusCode != 200 {
			t.Errorf("只读请求 %s 应认 URL 里的令牌，得到 %d %s", path, resp.StatusCode, clipForTest(raw))
		}
	}

	// 写接口：URL 里的令牌不算数
	writes := []struct{ path, body string }{
		{"/api/notebook/create?token=" + token, `{"name":"借令牌建的"}`},
		{"/api/pin/change?token=" + token, `{"old":"135790","new":"246810"}`},
	}
	for _, w := range writes {
		resp, _, raw := h.call(http.MethodPost, w.path, w.body, uidHeader("1000"))
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("写接口 %s 不该认 URL 里的令牌，得到 %d %s", w.path, resp.StatusCode, clipForTest(raw))
		}
	}

	// 但带上请求头就该成功（同一个令牌，换个通道）
	resp, _, raw := h.call(http.MethodPost, "/api/notebook/create?token="+token, `{"name":"正常建的"}`,
		map[string]string{"Authorization": "Bearer " + token, "X-Trim-Userid": "1000"})
	if resp.StatusCode != 200 {
		t.Errorf("带头写应成功，得到 %d %s", resp.StatusCode, clipForTest(raw))
	}
}

// TestTokenIsBoundToIdentity：令牌绑网关身份，换个 uid 用不了，并给出诊断原因。
func TestTokenIsBoundToIdentity(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")

	hdr := uidHeader("2000")
	hdr["Authorization"] = "Bearer " + token
	resp, rec, raw := h.call(http.MethodGet, "/api/tree", "", hdr)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("别人的身份不该能用这枚令牌：%d %s", resp.StatusCode, clipForTest(raw))
	}

	_, rec, raw = h.call(http.MethodGet, "/api/session", "", hdr)
	if rec["locked"] != true {
		t.Fatalf("应为未解锁：%s", clipForTest(raw))
	}
	if rec["reason"] != "identity_changed" || asString(rec["tokenUid"]) != "1000" {
		t.Fatalf("应给出「身份变了」的诊断（reason=identity_changed, tokenUid=1000），得到 %v", rec)
	}

	// 连令牌都没有时原因更简单
	_, rec, _ = h.call(http.MethodGet, "/api/session", "", uidHeader("2000"))
	if rec["reason"] != "no_token" {
		t.Fatalf("没带令牌时应是 no_token，得到 %v", rec["reason"])
	}
	// 带一枚废令牌
	hdr2 := uidHeader("1000")
	hdr2["Authorization"] = "Bearer deadbeef"
	_, rec, _ = h.call(http.MethodGet, "/api/session", "", hdr2)
	if rec["reason"] != "token_invalid" {
		t.Fatalf("废令牌应是 token_invalid，得到 %v", rec["reason"])
	}
}

// TestLockDropsAllChannels：上锁要把 Cookie 与自存令牌一起作废。
func TestLockDropsAllChannels(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")

	hdr := uidHeader("1000")
	hdr["Authorization"] = "Bearer " + token
	if resp, _, _ := h.call(http.MethodPost, "/api/pin/lock", "", hdr); resp.StatusCode != 200 {
		t.Fatalf("上锁失败：%d", resp.StatusCode)
	}
	hdr["Authorization"] = "Bearer " + token
	if resp, _, _ := h.call(http.MethodGet, "/api/tree", "", hdr); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("上锁后旧令牌应失效，得到 %d", resp.StatusCode)
	}
}

// TestSessionTokensParsing：通道优先级与「URL 参数只在只读请求生效」。
func TestSessionTokensParsing(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/tree?token=fromurl", nil)
	r.Header.Set("Authorization", "Bearer fromheader")
	r.Header.Set(tokenHeader, "fromcustom")
	r.AddCookie(&http.Cookie{Name: cookieName, Value: "fromcookie"})
	got := sessionTokens(r)
	want := []string{"fromheader", "fromcustom", "fromurl", "fromcookie"}
	if len(got) != len(want) {
		t.Fatalf("sessionTokens = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("通道优先级不对：得到 %v，期望 %v", got, want)
		}
	}

	// 重复的令牌只留一次（前端可能同时带头和 Cookie）
	r2 := httptest.NewRequest(http.MethodGet, "/api/tree", nil)
	r2.Header.Set("Authorization", "Bearer same")
	r2.AddCookie(&http.Cookie{Name: cookieName, Value: "same"})
	if got := sessionTokens(r2); len(got) != 1 {
		t.Fatalf("重复令牌应去重，得到 %v", got)
	}

	// 写请求：URL 参数不算数
	r3 := httptest.NewRequest(http.MethodPost, "/api/notebook/create?token=fromurl", nil)
	if got := sessionTokens(r3); len(got) != 0 {
		t.Fatalf("POST 不该解析 URL 令牌，得到 %v", got)
	}
}
