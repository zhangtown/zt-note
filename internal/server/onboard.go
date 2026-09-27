package server

import (
	_ "embed"
	"os"
	"path/filepath"
	"time"

	"ztnote/internal/siyuan"
	"ztnote/internal/store"
)

// 首次进入某个用户时，自动建一个笔记本 + 一篇欢迎文档，
// 并在用户目录里留一个标记文件，之后不再重复创建。
const (
	onboardMarker   = ".onboarded"
	welcomeTitle    = "欢迎使用云栖笔记"
	welcomeNotebook = "我的笔记"
)

// welcomeMarkdown 是新用户的欢迎文档内容（源文件 internal/server/welcome.md）。
//
//go:embed welcome.md
var welcomeMarkdown string

// ensureOnboarded 处理第一次进入：建「我的笔记」+ 欢迎文档。返回是否刚创建。
func (s *Server) ensureOnboarded(uid string, st *store.Store) (bool, error) {
	marker := filepath.Join(s.Users.Dir(uid), onboardMarker)
	if _, err := os.Stat(marker); err == nil {
		return false, nil
	}
	created := false
	if nbs, err := st.Notebooks(); err == nil && len(nbs) == 0 {
		box, err := st.CreateNotebook(welcomeNotebook)
		if err != nil {
			return false, err
		}
		doc := siyuan.MDToDoc(welcomeMarkdown, welcomeTitle, "")
		if _, err := st.WriteDoc(box, doc, ""); err != nil {
			return false, err
		}
		created = true
	}
	note := time.Now().Format(time.RFC3339) + "\n"
	if err := os.WriteFile(marker, []byte(note), 0o600); err != nil {
		return created, err
	}
	return created, nil
}
