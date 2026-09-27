package server

import (
	"net/http"
	"testing"
)

// 笔记本接口的状态码：参数错 400、找不到 404、系统目录也 400。
// 前端只显示 error 文本，但状态码是接口契约的一部分（别的客户端据此判断失败原因）。
func TestNotebookEndpointsStatusCodes(t *testing.T) {
	h := newTokenHarness(t)
	token := h.unlockAs("1000", "135790")
	// 手机 App 里 Cookie 存不住，靠这个头；用 h.withUID 是为了同时带上网关注入的身份
	auth := func() map[string]string { return h.withUID("1000", "X-Zt-Token: "+token) }

	resp, rec, raw := h.call(http.MethodPost, "/api/notebook/create", `{"name":"验收用本"}`, auth())
	if resp.StatusCode != http.StatusOK || asString(rec["id"]) == "" {
		t.Fatalf("新建笔记本应 200 + id，实际 %d %s", resp.StatusCode, clipForTest(raw))
	}
	box := asString(rec["id"])

	if resp, _, raw = h.call(http.MethodPost, "/api/notebook/rename", `{"id":"`+box+`","name":"改过的名"}`, auth()); resp.StatusCode != http.StatusOK {
		t.Fatalf("改名应 200，实际 %d %s", resp.StatusCode, clipForTest(raw))
	}

	// 缺 id：400
	if resp, _, _ = h.call(http.MethodPost, "/api/notebook/delete", `{}`, auth()); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺 id 应 400，实际 %d", resp.StatusCode)
	}

	// 系统目录 / 非法 id：400（绝不能 200，否则可能把 assets 删了）
	for _, body := range []string{`{"id":"assets"}`, `{"id":".."}`, `{"id":"../data"}`, `{"id":".siyuan"}`} {
		if resp, _, _ = h.call(http.MethodPost, "/api/notebook/delete", body, auth()); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("删 %s 应 400，实际 %d", body, resp.StatusCode)
		}
	}

	// 空名字改名：400
	if resp, _, _ = h.call(http.MethodPost, "/api/notebook/rename", `{"id":"`+box+`","name":"   "}`, auth()); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("空名改名应 400，实际 %d", resp.StatusCode)
	}

	// 不存在的笔记本：404
	if resp, _, _ = h.call(http.MethodPost, "/api/notebook/delete", `{"id":"20200101000000-abcdefg"}`, auth()); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("删不存在的笔记本应 404，实际 %d", resp.StatusCode)
	}
	if resp, _, _ = h.call(http.MethodPost, "/api/notebook/rename", `{"id":"20200101000000-abcdefg","name":"x"}`, auth()); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("改名不存在的笔记本应 404，实际 %d", resp.StatusCode)
	}

	// 真正删掉：200；再删一次 404
	if resp, _, raw = h.call(http.MethodPost, "/api/notebook/delete", `{"id":"`+box+`"}`, auth()); resp.StatusCode != http.StatusOK {
		t.Fatalf("删自己建的笔记本应 200，实际 %d %s", resp.StatusCode, clipForTest(raw))
	}
	if resp, _, _ = h.call(http.MethodPost, "/api/notebook/delete", `{"id":"`+box+`"}`, auth()); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删除应 404，实际 %d", resp.StatusCode)
	}
}
