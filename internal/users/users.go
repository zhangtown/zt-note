// Package users 提供飞牛网关身份解析，以及「每个用户一份数据」的目录布局。
//
// 统一网关会在请求头里带上可信身份（X-Trim-Userid / X-Trim-Username /
// X-Trim-Isadmin），未登录的请求在网关就被拦掉；本机 socket 直连或本地开发
// 没有这些头，回落为 local 用户。
//
// 布局（Base 通常是 $TRIM_PKGVAR）：
//
//	<Base>/users/<uid>/workspace   思源工作区（data/、assets/、history/）
//	<Base>/users/<uid>/pin.json    该用户的 6 位 PIN（哈希）
//
// uid 会进入路径，所以 Parse 必须先把非法字符挡掉。
package users

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 网关身份头（见飞牛开发者文档「统一网关 → 用户信息」）。
const (
	HeaderUID   = "X-Trim-Userid"
	HeaderName  = "X-Trim-Username"
	HeaderAdmin = "X-Trim-Isadmin"

	// LocalUID 是没有网关身份头时使用的用户标识（本地开发、维护脚本）。
	LocalUID = "local"

	dirUsers = "users"
	dirWork  = "workspace"
	pinFile  = "pin.json"
)

// Identity 是当前请求的用户身份。
type Identity struct {
	UID     string
	Name    string
	IsAdmin bool
	Local   bool // 不是网关转发来的（本机 socket / 本地开发）
}

// Parse 解析网关身份头。uid 非法（空、超长、含路径字符）时回落为 local。
func Parse(uid, name, admin string) Identity {
	uid = strings.TrimSpace(uid)
	name = strings.TrimSpace(name)
	id := Identity{UID: uid, Name: name, IsAdmin: admin == "true"}
	if !ValidUID(uid) {
		id.UID = LocalUID
		id.Name = strings.TrimSpace(name)
		id.IsAdmin = false // 身份不可信时也不给它管理员标记
		id.Local = true
		return id
	}
	if id.Name == "" {
		id.Name = uid
	}
	return id
}

// Display 返回界面展示用的名字。
func (i Identity) Display() string {
	if i.Name != "" {
		return i.Name
	}
	return i.UID
}

// ValidUID 判断 uid 是否可以安全地用作目录名。
func ValidUID(uid string) bool {
	if uid == "" || len(uid) > 32 {
		return false
	}
	for _, r := range uid {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// Root 是应用数据根目录。
type Root struct{ Base string }

// NewRoot 创建数据根。
func NewRoot(base string) Root {
	if abs, err := filepath.Abs(base); err == nil {
		base = abs
	}
	return Root{Base: base}
}

// UsersDir 返回所有用户数据的父目录。
func (r Root) UsersDir() string { return filepath.Join(r.Base, dirUsers) }

// Dir 返回某个用户的数据目录（不含创建）。
func (r Root) Dir(uid string) string {
	if !ValidUID(uid) {
		uid = LocalUID
	}
	return filepath.Join(r.UsersDir(), uid)
}

// Workspace 返回某个用户的思源工作区路径。
func (r Root) Workspace(uid string) string { return filepath.Join(r.Dir(uid), dirWork) }

// PinFile 返回某个用户的 PIN 文件路径。
func (r Root) PinFile(uid string) string { return filepath.Join(r.Dir(uid), pinFile) }

// HasWorkspace 判断某个用户是否已经有工作区（不创建）。
func (r Root) HasWorkspace(uid string) bool {
	st, err := os.Stat(filepath.Join(r.Workspace(uid), "data"))
	return err == nil && st.IsDir()
}

// Ensure 创建某个用户的数据目录与工作区，返回工作区路径。
func (r Root) Ensure(uid string) (string, error) {
	dir := r.Dir(uid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("创建用户目录失败: %w", err)
	}
	ws := filepath.Join(dir, dirWork)
	if err := os.MkdirAll(ws, 0o755); err != nil {
		return "", fmt.Errorf("创建工作区失败: %w", err)
	}
	return ws, nil
}

// List 列出已经有数据的用户 uid。
func (r Root) List() []string {
	entries, err := os.ReadDir(r.UsersDir())
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || !ValidUID(e.Name()) {
			continue
		}
		out = append(out, e.Name())
	}
	return out
}

// MigrateLegacy 把旧版单用户工作区 <Base>/workspace 迁给 owner。
//
// 幂等：只有「旧目录里有工作区」且「目标用户还没有工作区」时才搬。
// 返回是否真的迁移过。
func (r Root) MigrateLegacy(owner string) (bool, error) {
	if !ValidUID(owner) {
		return false, fmt.Errorf("非法的迁移目标 uid: %q", owner)
	}
	legacy := filepath.Join(r.Base, dirWork)
	if !isWorkspace(legacy) {
		return false, nil
	}
	target := r.Workspace(owner)
	if isWorkspace(target) {
		return false, nil // 已经迁过
	}
	if err := os.MkdirAll(r.UsersDir(), 0o700); err != nil {
		return false, err
	}
	// 目标目录可能存在但为空（用户先访问过、建过空壳），清掉再搬。
	if _, err := os.Stat(filepath.Join(r.Dir(owner), dirWork)); err == nil {
		if err := os.RemoveAll(filepath.Join(r.Dir(owner), dirWork)); err != nil {
			return false, err
		}
	}
	if err := os.MkdirAll(r.Dir(owner), 0o700); err != nil {
		return false, err
	}
	if err := os.Rename(legacy, target); err != nil {
		return false, fmt.Errorf("迁移工作区失败: %w", err)
	}
	return true, nil
}

// isWorkspace 判断目录是否是思源工作区（含 data/）。
func isWorkspace(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "data"))
	return err == nil && st.IsDir()
}
