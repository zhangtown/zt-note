package importer

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ztnote/internal/siyuan"
	"ztnote/internal/store"
)

const (
	testBox   = "20250708095329-8rxeagf"
	testDocID = "20250604143405-29orui7"
	testAsset = "一月-20250604085900-o62voq2.png"
	testRef   = "assets/" + testAsset
)

// 导入必须让文档里的 assets/xxx.png 依旧指得到图（否则图片全 404）。
// 这两条测试卡的是这个契约：① 首次导入沿用原文件名、引用不动；② 目标已有同
// 名文件时新文件改名，同时把文档里的引用一起改掉，且不覆盖已有文件。

// syDoc 造一份最小思源文档：段落里一张图，引用 ref。
func syDoc(ref string) string {
	return `{"ID":"` + testDocID + `","Spec":"1","Type":"NodeDocument",` +
		`"Properties":{"id":"` + testDocID + `","title":"示例文稿","type":"doc"},` +
		`"Children":[{"ID":"20250604063404-nhmlm42","Type":"NodeParagraph",` +
		`"Properties":{"id":"20250604063404-nhmlm42"},"Children":[` +
		`{"Type":"NodeText","Data":"1月"},` +
		`{"Type":"NodeImage","Data":"span","Properties":{"parent-style":"width: 25%;","style":"width: 10000px;"},` +
		`"Children":[{"Type":"NodeLinkDest","Data":"` + ref + `"}]}]}]}`
}

func siyuanZip(t *testing.T) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string]string{
		".siyuan/conf.json":               `{"name":"示例笔记本"}`,
		testBox + "/" + testDocID + ".sy": syDoc(testRef),
		"assets/" + testAsset:             "PNG-新图",
	}
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("创建 zip 条目 %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("写入 zip 条目 %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("打开 zip: %v", err)
	}
	return zr
}

// docAssetRef 取出导入后文档里那一条资源引用。
func docAssetRef(t *testing.T, s *store.Store) string {
	t.Helper()
	doc, _, err := s.Load(testBox, testDocID)
	if err != nil {
		t.Fatalf("读取导入后的文档: %v", err)
	}
	var found []string
	var walk func(n *siyuan.Node)
	walk = func(n *siyuan.Node) {
		if n == nil {
			return
		}
		if strings.HasPrefix(n.Data, "assets/") {
			found = append(found, n.Data)
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(doc)
	if len(found) != 1 {
		t.Fatalf("期望文档里有 1 条资源引用，实际 %v", found)
	}
	return found[0]
}

func TestImportKeepsAssetNames(t *testing.T) {
	s := store.New(t.TempDir())
	res, err := ImportZip(s, siyuanZip(t))
	if err != nil {
		t.Fatalf("ImportZip: %v", err)
	}
	if res.Docs != 1 || res.Assets != 1 {
		t.Fatalf("导入计数不对：docs=%d assets=%d notes=%v", res.Docs, res.Assets, res.Notes)
	}
	if ref := docAssetRef(t, s); ref != testRef {
		t.Errorf("首次导入应沿用原文件名，引用 = %q，期望 %q", ref, testRef)
	}
	p := filepath.Join(s.AssetsDir(), testAsset)
	if b, err := os.ReadFile(p); err != nil {
		t.Errorf("资源没按原名落盘（%s）：%v", p, err)
	} else if string(b) != "PNG-新图" {
		t.Errorf("资源内容不对：%q", string(b))
	}
}

func TestImportRewritesRenamedAssetRefs(t *testing.T) {
	s := store.New(t.TempDir())
	// 目标工作区已有同名图片（重复导入、或用户自己传过一张同名的）
	if err := os.MkdirAll(s.AssetsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(s.AssetsDir(), testAsset)
	if err := os.WriteFile(oldPath, []byte("PNG-旧图"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := ImportZip(s, siyuanZip(t)); err != nil {
		t.Fatalf("ImportZip: %v", err)
	}

	ref := docAssetRef(t, s)
	if ref == testRef {
		t.Fatalf("同名冲突时资源必须改名，引用却还是 %q（会串图）", ref)
	}
	if !strings.HasPrefix(ref, "assets/一月-20250604085900-o62voq2-") || !strings.HasSuffix(ref, ".png") {
		t.Errorf("改名后的引用不像 <原名>-<时间戳>-<随机>.<ext>：%q", ref)
	}
	name := strings.TrimPrefix(ref, "assets/")
	if b, err := os.ReadFile(filepath.Join(s.AssetsDir(), name)); err != nil {
		t.Errorf("改写后的引用 %q 指向的文件不存在：%v", ref, err)
	} else if string(b) != "PNG-新图" {
		t.Errorf("新资源内容不对：%q", string(b))
	}
	if b, err := os.ReadFile(oldPath); err != nil || string(b) != "PNG-旧图" {
		t.Errorf("已有同名图片被覆盖：%q err=%v", string(b), err)
	}
}

func TestRewriteAssetRefsHandlesPrefixAndBackslash(t *testing.T) {
	refs := map[string]string{testAsset: "assets/renamed.png"}
	doc := &siyuan.Node{Children: []*siyuan.Node{
		{Type: "NodeLinkDest", Data: testRef},                     // assets/xxx.png
		{Type: "NodeLinkDest", Data: "data/assets/" + testAsset},  // 带前缀
		{Type: "NodeLinkDest", Data: "assets\\" + testAsset},      // 反斜杠
		{Type: "NodeLinkDest", Data: "assets/其他.png"},             // 没改名，不动
		{Type: "NodeLinkDest", Data: "https://example.com/x.png"}, // 外链，不动
		{Type: "NodeTextMark", TextHref: "assets/" + testAsset},   // 文本里的超链接
	}}
	rewriteAssetRefs(doc, refs)
	want := []string{
		"assets/renamed.png",
		"assets/renamed.png",
		"assets/renamed.png",
		"assets/其他.png",
		"https://example.com/x.png",
		"assets/renamed.png", // 文本超链接里的引用同样改写（读的是 TextHref）
	}
	for i, n := range doc.Children {
		got := n.Data
		if i == len(doc.Children)-1 {
			got = n.TextHref
		}
		if got != want[i] {
			t.Errorf("第 %d 个节点改写结果 %q，期望 %q", i, got, want[i])
		}
	}
}
