#!/usr/bin/env bash
# zt-note 统一构建入口：保证内嵌前端（internal/webui/dist）与 Go 二进制始终同步。
#
#   bash build.sh            # Windows 开发二进制 .test/ztnote.exe
#   bash build.sh fpk        # 飞牛安装包 deploy/fnos-app/zt-note.fpk
#   bash build.sh all        # 两者都建
#   UI=1 bash build.sh ...   # 强制重建前端
#
# 前端只在「ui/ 源码比 dist 新」或 dist 缺失时才重建（vite 产物直接写入
# internal/webui/dist，go:embed 打包，所以改前端后必须重新 go build）。
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

# 定位 go（新开的 shell 里 PATH 可能没有）
if ! command -v go >/dev/null 2>&1; then
  for c in /c/Users/*/go-sdk/go/bin/go.exe "$USERPROFILE/go-sdk/go/bin/go.exe" /usr/local/go/bin/go; do
    [ -x "$c" ] && export PATH="$(dirname "$c"):$PATH" && break
  done
fi
command -v go >/dev/null 2>&1 || { echo "未找到 go，请把 Go 加进 PATH"; exit 1; }

DIST=internal/webui/dist
need_ui() {
  [ -n "$UI" ] && return 0
  [ -f "$DIST/index.html" ] || return 0
  # 源码里最新修改时间晚于产物 → 需要重建
  newest=$(find ui/src ui/index.html ui/package.json ui/vite.config.ts -type f -newer "$DIST/index.html" 2>/dev/null | head -n1)
  [ -n "$newest" ]
}

if need_ui; then
  echo "== 构建前端（ui → $DIST）"
  ( cd ui && npm run build )
else
  echo "== 前端产物已是最新，跳过（用 UI=1 强制重建）"
fi
echo "   产物目录：$DIST → $(ls -1 "$DIST" | tr '\n' ' ')"
echo "   静态资源：$(ls -1 "$DIST/${STATIC_DIR:-static}" 2>/dev/null | tr '\n' ' ')"

case "${1:-dev}" in
  dev)
    mkdir -p .test
    echo "== 构建开发二进制 .test/ztnote.exe"
    go build -trimpath -o .test/ztnote.exe ./cmd/ztnote
    echo "== done"
    echo "   启动：.test/ztnote.exe -workspace .test/workspace -addr 127.0.0.1:8765"
    ;;
  fpk)
    bash deploy/fnos-app/pack.sh
    ;;
  all)
    mkdir -p .test
    go build -trimpath -o .test/ztnote.exe ./cmd/ztnote
    bash deploy/fnos-app/pack.sh
    ;;
  *)
    echo "用法：bash build.sh [dev|fpk|all]"; exit 1
    ;;
esac
