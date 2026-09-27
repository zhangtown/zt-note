package users

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		name       string
		uid, uname string
		admin      string
		wantUID    string
		wantName   string
		wantAdmin  bool
		wantLocal  bool
	}{
		{name: "网关正常身份", uid: "1000", uname: "zhangtown", admin: "true", wantUID: "1000", wantName: "zhangtown", wantAdmin: true},
		{name: "非管理员", uid: "1002", uname: "guest", admin: "false", wantUID: "1002", wantName: "guest"},
		{name: "缺用户名时用 uid 顶", uid: "1000", uname: "", admin: "true", wantUID: "1000", wantName: "1000", wantAdmin: true},
		{name: "没有身份头 → local", uid: "", uname: "", admin: "", wantUID: LocalUID, wantName: LocalUID, wantLocal: true},
		{name: "非法 uid（路径穿越）→ local", uid: "../../etc", uname: "x", admin: "true", wantUID: LocalUID, wantName: "x", wantLocal: true},
		{name: "非法 uid（斜杠）→ local", uid: "a/b", uname: "x", admin: "", wantUID: LocalUID, wantName: "x", wantLocal: true},
		{name: "非法 uid（中文）→ local", uid: "张三", uname: "张三", admin: "", wantUID: LocalUID, wantName: "张三", wantLocal: true},
		{name: "过长 uid → local", uid: strings.Repeat("a", 33), uname: "", admin: "", wantUID: LocalUID, wantName: LocalUID, wantLocal: true},
		{name: "下划线与短横线可以", uid: "nas_user-2", uname: "u", admin: "", wantUID: "nas_user-2", wantName: "u"},
	}
	for _, c := range cases {
		got := Parse(c.uid, c.uname, c.admin)
		if got.UID != c.wantUID || got.IsAdmin != c.wantAdmin || got.Local != c.wantLocal {
			t.Errorf("%s: Parse(%q,%q,%q) = {uid:%q admin:%v local:%v}，期望 {uid:%q admin:%v local:%v}",
				c.name, c.uid, c.uname, c.admin, got.UID, got.IsAdmin, got.Local, c.wantUID, c.wantAdmin, c.wantLocal)
		}
		if got.Display() != c.wantName {
			t.Errorf("%s: Display() = %q，期望 %q", c.name, got.Display(), c.wantName)
		}
	}
	// 管理员必须是字符串 true，其它一律 false
	if Parse("1000", "a", "TRUE").IsAdmin {
		t.Error("Isadmin 只应接受小写 true")
	}
}

func TestDisplayFallback(t *testing.T) {
	if got := (Identity{UID: "1000"}).Display(); got != "1000" {
		t.Errorf("Display() = %q，期望回落到 uid", got)
	}
}

func TestValidUID(t *testing.T) {
	for _, ok := range []string{"1000", "local", "a_b-c", "ABC123"} {
		if !ValidUID(ok) {
			t.Errorf("ValidUID(%q) = false，期望 true", ok)
		}
	}
	for _, bad := range []string{"", " ", "a b", "a/b", "a\\b", "../x", "张三", strings.Repeat("x", 33)} {
		if ValidUID(bad) {
			t.Errorf("ValidUID(%q) = true，期望 false", bad)
		}
	}
}

func TestRootPaths(t *testing.T) {
	base := t.TempDir()
	r := NewRoot(base)
	if r.UsersDir() != filepath.Join(r.Base, "users") {
		t.Errorf("UsersDir() = %q", r.UsersDir())
	}
	if r.Workspace("1000") != filepath.Join(r.Base, "users", "1000", "workspace") {
		t.Errorf("Workspace(1000) = %q", r.Workspace("1000"))
	}
	if r.PinFile("1000") != filepath.Join(r.Base, "users", "1000", "pin.json") {
		t.Errorf("PinFile(1000) = %q", r.PinFile("1000"))
	}
	// 非法 uid 不能逃出 users/ 目录
	if r.Workspace("../../evil") != filepath.Join(r.Base, "users", LocalUID, "workspace") {
		t.Errorf("非法 uid 未回落到 local：%q", r.Workspace("../../evil"))
	}
}

func TestEnsureAndHasWorkspace(t *testing.T) {
	r := NewRoot(t.TempDir())
	if r.HasWorkspace("1000") {
		t.Error("新数据根不该有工作区")
	}
	ws, err := r.Ensure("1000")
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st, err := os.Stat(ws); err != nil || !st.IsDir() {
		t.Fatalf("Ensure 没建出工作区 %s: %v", ws, err)
	}
	// Ensure 只建目录，HasWorkspace 以 data/ 为准 —— 此时还不算「有库」
	if r.HasWorkspace("1000") {
		t.Error("只有空目录时 HasWorkspace 应该是 false")
	}
	if err := os.MkdirAll(filepath.Join(ws, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !r.HasWorkspace("1000") {
		t.Error("有 data/ 后 HasWorkspace 应该是 true")
	}
}

func TestMigrateLegacy(t *testing.T) {
	base := t.TempDir()
	r := NewRoot(base)
	legacy := filepath.Join(base, "workspace")
	if err := os.MkdirAll(filepath.Join(legacy, "data", "box1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "data", "box1", "doc.sy"), []byte(`{"ID":"doc"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// 目标用户先访问过、留下一个空壳工作区：迁移要能清掉空壳再搬
	shell := filepath.Join(base, "users", "1000", "workspace")
	if err := os.MkdirAll(shell, 0o755); err != nil {
		t.Fatal(err)
	}

	moved, err := r.MigrateLegacy("1000")
	if err != nil {
		t.Fatalf("MigrateLegacy: %v", err)
	}
	if !moved {
		t.Fatal("应该报告迁移成功")
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Errorf("旧目录仍在：%v", err)
	}
	if !r.HasWorkspace("1000") {
		t.Error("迁移后目标用户应该有工作区")
	}
	b, err := os.ReadFile(filepath.Join(r.Workspace("1000"), "data", "box1", "doc.sy"))
	if err != nil || string(b) != `{"ID":"doc"}` {
		t.Errorf("迁移后文件内容不对: %q %v", b, err)
	}

	// 幂等：再调一次什么都不做（旧目录已经没了）
	moved, err = r.MigrateLegacy("1000")
	if err != nil || moved {
		t.Errorf("重复迁移应返回 false,nil，得到 %v,%v", moved, err)
	}

	// 目标用户已经有真库时，即便旧目录又出现也不能覆盖
	if err := os.MkdirAll(filepath.Join(legacy, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	moved, err = r.MigrateLegacy("1000")
	if err != nil || moved {
		t.Errorf("目标已有库时不该迁移，得到 %v,%v", moved, err)
	}

	// 非法 owner
	if _, err := r.MigrateLegacy("../x"); err == nil {
		t.Error("非法 owner 应该报错")
	}
	// 旧目录存在但没有 data/（不是工作区）→ 不迁
	r2 := NewRoot(t.TempDir())
	if err := os.MkdirAll(filepath.Join(r2.Base, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	if moved, err := r2.MigrateLegacy("1000"); err != nil || moved {
		t.Errorf("空壳旧目录不该被迁移，得到 %v,%v", moved, err)
	}
}

func TestList(t *testing.T) {
	r := NewRoot(t.TempDir())
	for _, uid := range []string{"1000", "1001"} {
		if _, err := r.Ensure(uid); err != nil {
			t.Fatal(err)
		}
	}
	// 噪音：非法名的目录、文件，都不该出现在列表里
	if err := os.MkdirAll(filepath.Join(r.UsersDir(), "张三"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.UsersDir(), "note.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(r.List(), ",")
	if got != "1000,1001" {
		t.Errorf("List() = %q，期望 1000,1001", got)
	}
	// 空根不报错
	if list := NewRoot(t.TempDir()).List(); len(list) != 0 {
		t.Errorf("空根 List() = %v，期望空", list)
	}
}
