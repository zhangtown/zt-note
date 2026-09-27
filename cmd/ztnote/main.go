// Command ztnote 是 fnOS 上的思源笔记类应用服务端。
//
// 单二进制：内嵌前端 + 思源 .sy 存储 + HTTP API。
// 支持两种监听：Unix socket（飞牛统一网关）与 TCP（本地开发）。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ztnote/internal/server"
	"ztnote/internal/users"
)

// version 由构建脚本注入：-ldflags "-X main.version=..."
var version = "0.1.0-dev"

func main() {
	var (
		dataDir     = flag.String("data", "", "数据根目录（内含 users/<uid>/workspace）。默认 $TRIM_PKGVAR")
		legacyOwner = flag.String("legacy-owner", "", "把旧的单用户 workspace 迁给这个 uid。默认 $ZTNOTE_LEGACY_OWNER 或 1000")
		addr        = flag.String("addr", "", "TCP 监听地址（开发用），如 127.0.0.1:8765")
		sock        = flag.String("sock", "", "Unix socket 路径。默认 $TRIM_APPDEST/app.sock")
		prefix      = flag.String("prefix", "", "URL 前缀。默认 $GATEWAY_PREFIX 或 /app/zt-note")
		showVer     = flag.Bool("version", false, "打印版本号")
	)
	flag.Parse()

	if *showVer {
		fmt.Println(version)
		return
	}

	logger := log.New(os.Stdout, "", log.LstdFlags)

	// ---- 数据根：每个用户一份工作区
	root := firstNonEmpty(*dataDir, os.Getenv("ZTNOTE_DATA"), os.Getenv("ZTNOTE_WORKSPACE"))
	if root == "" {
		if v := os.Getenv("TRIM_PKGVAR"); v != "" {
			root = v
		} else {
			root = "data"
		}
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	dataRoot := users.NewRoot(root)

	// 旧版只有一份 workspace：升级时迁给 owner（默认 1000，飞牛第一个管理员）
	owner := firstNonEmpty(*legacyOwner, os.Getenv("ZTNOTE_LEGACY_OWNER"), "1000")
	if moved, err := dataRoot.MigrateLegacy(owner); err != nil {
		logger.Printf("旧数据迁移失败: %v", err)
	} else if moved {
		logger.Printf("已把旧的单用户工作区迁给 uid %s → %s", owner, dataRoot.Workspace(owner))
	}

	// ---- 前缀
	pfx := firstNonEmpty(*prefix, os.Getenv("GATEWAY_PREFIX"), "/app/zt-note")
	if pfx != "" && !strings.HasPrefix(pfx, "/") {
		pfx = "/" + pfx
	}
	pfx = strings.TrimSuffix(pfx, "/")

	srv := server.New(root, pfx, version, logger)

	// ---- 监听
	var listeners []net.Listener
	sockPath := firstNonEmpty(*sock, os.Getenv("ZTNOTE_SOCK"))
	if sockPath == "" {
		if dest := os.Getenv("TRIM_APPDEST"); dest != "" {
			sockPath = filepath.Join(dest, "app.sock")
		}
	}
	if sockPath != "" {
		_ = os.Remove(sockPath)
		ln, err := net.Listen("unix", sockPath)
		if err != nil {
			logger.Fatalf("监听 unix socket 失败 (%s): %v", sockPath, err)
		}
		_ = os.Chmod(sockPath, 0o666)
		listeners = append(listeners, ln)
		logger.Printf("unix socket: %s", sockPath)
	}

	tcpAddr := firstNonEmpty(*addr, os.Getenv("ZTNOTE_ADDR"))
	if tcpAddr == "" && len(listeners) == 0 {
		tcpAddr = "127.0.0.1:8765"
	}
	if tcpAddr != "" {
		ln, err := net.Listen("tcp", tcpAddr)
		if err != nil {
			logger.Fatalf("监听 %s 失败: %v", tcpAddr, err)
		}
		listeners = append(listeners, ln)
		logger.Printf("http: http://%s%s", tcpAddr, pfx)
	}
	if len(listeners) == 0 {
		logger.Fatalf("没有可用的监听地址")
	}

	logger.Printf("zt-note %s 启动，数据根 %s，URL 前缀 %s", version, root, pfx)
	if list := dataRoot.List(); len(list) > 0 {
		logger.Printf("已启用用户: %s", strings.Join(list, ", "))
	}

	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	errCh := make(chan error, len(listeners))
	for _, ln := range listeners {
		go func(l net.Listener) {
			if err := httpSrv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}(ln)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errCh:
		logger.Printf("服务异常: %v", err)
	case sig := <-sigCh:
		logger.Printf("收到信号 %v，正在退出", sig)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	if sockPath != "" {
		_ = os.Remove(sockPath)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
