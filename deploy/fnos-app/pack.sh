#!/usr/bin/env bash
# Build zt-note.fpk (fnOS native app, unified gateway mode).
#
#   bash deploy/fnos-app/pack.sh            # 前端用已有 internal/webui/dist
#   UI=1 bash deploy/fnos-app/pack.sh       # 先跑 npm run build 再打包
#   BUMP=1 bash deploy/fnos-app/pack.sh     # 先把 manifest 的版本号 patch +1 再打包
#
# 升级要注意（实测）：
#   - `appcenter-cli install-fpk` 对**已安装**的同名应用是空操作（即使版本号更高！）
#     → 只会打印 "Application [zt-note] is installed."，文件一个字节都不换
#   - 真正替换要 `install-local -d <解包目录> -v <卷>`（卸载+安装；@appdata 里的笔记数据不动）
#   - 所以本脚本只负责产出 fpk，安装/升级走 deploy/fnos-app/install.sh
#
# Prereq: fnpack for Windows in .toolchain/fnpack/fnpack.exe
#   download: https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64
#
# Output: deploy/fnos-app/zt-note.fpk  (install with `bash deploy/fnos-app/install.sh`)
set -e
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
APP=deploy/fnos-app/zt-note
FNPACK=.toolchain/fnpack/fnpack.exe

# 0) 可选：递增 manifest 里的 patch 版本
if [ -n "$BUMP" ]; then
  cur="$(sed -n 's/^version=//p' "$APP/manifest" | head -n1)"
  new="$(printf '%s' "$cur" | awk -F. '{printf "%s.%s.%d", $1, $2, $3+1}')"
  sed -i "s/^version=.*/version=$new/" "$APP/manifest"
  echo "== 版本 $cur → $new"
fi
VERSION="$(sed -n 's/^version=//p' "$APP/manifest" | head -n1)"

# locate go (fresh shells may lack it on PATH)
if ! command -v go >/dev/null 2>&1; then
  for c in /c/Users/*/go-sdk/go/bin/go.exe "$USERPROFILE/go-sdk/go/bin/go.exe" /usr/local/go/bin/go; do
    [ -x "$c" ] && export PATH="$(dirname "$c"):$PATH" && break
  done
fi
command -v go >/dev/null 2>&1 || { echo "go not found"; exit 1; }

# 1) 图标（幂等，随时重生成）
echo "== 生成图标"
go run ./tools/mkicon -out "$APP"

# 2) 前端（可选，Vite 直接输出到 internal/webui/dist）
if [ -n "$UI" ]; then
  echo "== 构建前端 (vite)"
  ( cd ui && npm run build )
fi
if [ ! -f internal/webui/dist/index.html ]; then
  echo "internal/webui/dist 不存在，请先构建前端：cd ui && npm ci && npm run build"; exit 1
fi
echo "== 前端产物: $(ls internal/webui/dist | tr '\n' ' ') / $(ls internal/webui/dist/static 2>/dev/null | tr '\n' ' ')"

# 3) 后端（linux/amd64 静态二进制，前端由 go:embed 打进包里）
echo "== 构建 ztnote (linux/amd64)"
mkdir -p "$APP/app/bin"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags="-s -w -X main.version=$VERSION" \
  -o "$APP/app/bin/ztnote" ./cmd/ztnote
chmod +x "$APP/app/bin/ztnote"
ls -la "$APP/app/bin/ztnote"

# 4) 打包
echo "== fnpack build"
[ -x "$FNPACK" ] || { echo "缺少 $FNPACK（见脚本头注释下载）；也可用 PATH 里的 fnpack"; exit 1; }
"$FNPACK" build --directory "$APP"
mv -f ./*.fpk deploy/fnos-app/ 2>/dev/null || true
ls -la deploy/fnos-app/*.fpk
echo
echo "== done: deploy/fnos-app/zt-note.fpk  ($VERSION)"
echo "   安装/升级：bash deploy/fnos-app/install.sh --no-bump"
echo "   或：飞牛 → 应用中心 → 手动安装（install-fpk 对已装应用无效）"
