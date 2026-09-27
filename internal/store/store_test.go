package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"ztnote/internal/siyuan"
)

// 笔记本的新建 / 重命名 / 删除，以及「不能删系统目录」的保护。
// 这些是右键菜单背后的接口，删错一个目录就是用户的图片资源没了，所以要锁死。

func newStore(t *testing.T) *Store {
	t.Helper()
	s := New(filepath.Join(t.TempDir(), "workspace"))
	if err := s.Ensure(); err != nil {
		t.Fatalf("Ensure(): %v", err)
	}
	return s
}

func readConf(t *testing.T, s *Store, box string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(s.DataDir(), box, ".siyuan", "conf.json"))
	if err != nil {
		t.Fatalf("读 conf.json: %v", err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("conf.json 不是合法 JSON: %v", err)
	}
	return m
}

func TestNotebookCreateRenameDelete(t *testing.T) {
	s := newStore(t)

	id, err := s.CreateNotebook("我的笔记本")
	if err != nil {
		t.Fatalf("CreateNotebook: %v", err)
	}
	if !siyuan.IsBoxID(id) {
		t.Fatalf("新笔记本 id 不是思源 box id: %q", id)
	}
	if _, err := os.Stat(filepath.Join(s.DataDir(), id, ".siyuan")); err != nil {
		t.Fatalf("没有建出 .siyuan 目录: %v", err)
	}

	nbs, err := s.Notebooks()
	if err != nil {
		t.Fatalf("Notebooks: %v", err)
	}
	if len(nbs) != 1 || nbs[0].Name != "我的笔记本" {
		t.Fatalf("新建后应有 1 个名为「我的笔记本」的笔记本，实际 %+v", nbs)
	}

	// 思源自己写在 conf.json 里的其它字段（sort/closed/自定义）改名时要保留
	confPath := filepath.Join(s.DataDir(), id, ".siyuan", "conf.json")
	raw, _ := json.Marshal(map[string]any{"name": "我的笔记本", "sort": 7, "closed": true, "custom": "keep-me"})
	if err := os.WriteFile(confPath, raw, 0o644); err != nil {
		t.Fatalf("写 conf.json: %v", err)
	}

	if err := s.RenameNotebook(id, "  改名后的本  "); err != nil {
		t.Fatalf("RenameNotebook: %v", err)
	}
	conf := readConf(t, s, id)
	if conf["name"] != "改名后的本" {
		t.Fatalf("改名的名字不对（应去掉首尾空格）: %v", conf["name"])
	}
	if conf["custom"] != "keep-me" || conf["sort"] != float64(7) || conf["closed"] != true {
		t.Fatalf("改名把其它字段改坏了: %+v", conf)
	}
	nbs, _ = s.Notebooks()
	if len(nbs) != 1 || nbs[0].Name != "改名后的本" {
		t.Fatalf("改名后列表没跟上: %+v", nbs)
	}

	// 删掉之后：目录没了，列表也空了
	if err := s.DeleteNotebook(id); err != nil {
		t.Fatalf("DeleteNotebook: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.DataDir(), id)); !os.IsNotExist(err) {
		t.Fatalf("删除后目录还在: err=%v", err)
	}
	if nbs, _ = s.Notebooks(); len(nbs) != 0 {
		t.Fatalf("删除后不该还有笔记本: %+v", nbs)
	}
}

// 空名字走默认名；id 不合法时删/改名都必须报错。
func TestNotebookGuards(t *testing.T) {
	s := newStore(t)

	id, err := s.CreateNotebook("")
	if err != nil {
		t.Fatalf("CreateNotebook(空名): %v", err)
	}
	if got := readConf(t, s, id)["name"]; got != "新笔记本" {
		t.Fatalf("空名应回落到「新笔记本」，实际 %v", got)
	}

	// 删笔记本不能把系统目录 / 工作区根目录带走
	for _, box := range []string{"", "assets", "templates", "storage", "widgets", "plugins", "emojis", ".siyuan", "../data", `..\data`, ".."} {
		if err := s.DeleteNotebook(box); !errors.Is(err, ErrBadBoxID) {
			t.Fatalf("DeleteNotebook(%q) 应报 ErrBadBoxID，实际 %v", box, err)
		}
		if err := s.RenameNotebook(box, "x"); !errors.Is(err, ErrBadBoxID) {
			t.Fatalf("RenameNotebook(%q) 应报 ErrBadBoxID，实际 %v", box, err)
		}
	}
	if _, err := os.Stat(s.AssetsDir()); err != nil {
		t.Fatalf("assets 目录不应受影响: %v", err)
	}

	// 不存在的笔记本 / 文件占位的同号路径
	if err := s.DeleteNotebook("20200101000000-abcdefg"); !errors.Is(err, ErrNotebookAbsent) {
		t.Fatalf("删不存在的笔记本应报 ErrNotebookAbsent，实际 %v", err)
	}
	notDir := filepath.Join(s.DataDir(), "20200101000001-abcdefg")
	if err := os.MkdirAll(s.DataDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(notDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteNotebook("20200101000001-abcdefg"); !errors.Is(err, ErrNotebookAbsent) {
		t.Fatalf("同名文件不是笔记本，应报 ErrNotebookAbsent，实际 %v", err)
	}
	if err := s.RenameNotebook("20200101000001-abcdefg", "x"); !errors.Is(err, ErrNotebookAbsent) {
		t.Fatalf("同名文件改名应报 ErrNotebookAbsent，实际 %v", err)
	}

	// 空名字不能把笔记本改成无名
	if err := s.RenameNotebook(id, "   "); !errors.Is(err, ErrEmptyNotebookName) {
		t.Fatalf("空名改名应报 ErrEmptyNotebookName，实际 %v", err)
	}
}

// 列表里不该出现系统目录，也不该出现「不是 box id 且没有文档」的杂目录。
func TestNotebooksSkipSystemAndStrayDirs(t *testing.T) {
	s := newStore(t)
	if err := os.MkdirAll(filepath.Join(s.DataDir(), "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(s.DataDir(), ".siyuan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(s.DataDir(), "随手建的目录"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateNotebook("正常笔记本"); err != nil {
		t.Fatal(err)
	}

	nbs, err := s.Notebooks()
	if err != nil {
		t.Fatalf("Notebooks: %v", err)
	}
	if len(nbs) != 1 || nbs[0].Name != "正常笔记本" {
		t.Fatalf("只应看到真实笔记本，实际 %+v", nbs)
	}

	// 没有 conf.json 时名字回落到目录名（便于用户手工丢进来的目录）
	conf := filepath.Join(s.DataDir(), nbs[0].ID, ".siyuan", "conf.json")
	if err := os.Remove(conf); err != nil {
		t.Fatal(err)
	}
	nbs, _ = s.Notebooks()
	if len(nbs) != 1 || nbs[0].Name != nbs[0].ID {
		t.Fatalf("缺 conf.json 时名字应用目录名，实际 %+v", nbs)
	}
}
