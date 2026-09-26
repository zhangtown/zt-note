// Package webui 内嵌前端构建产物（ui/ 由 Vite 构建到 internal/webui/dist）。
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS 返回前端静态资源文件系统（根为 dist）。
func FS() (fs.FS, error) { return fs.Sub(dist, "dist") }

// Available 表示前端是否已构建。
func Available() bool {
	f, err := FS()
	if err != nil {
		return false
	}
	_, err = fs.Stat(f, "index.html")
	return err == nil
}
