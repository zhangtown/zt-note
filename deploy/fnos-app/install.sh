#!/usr/bin/env bash
# 一键部署/升级 zt-note 到飞牛 NAS（打包 → 上传 → 安装 → 验证）
#
#   bash deploy/fnos-app/install.sh              # 默认：版本号 patch+1 后打包并安装
#   bash deploy/fnos-app/install.sh --no-bump    # 用当前版本号（首次安装用）
#
# 环境变量（都有默认值）：
#   NAS=user@your-nas.local   NAS_PORT=2288   NAS_KEY=~/.ssh/id_ed25519   NAS_VOL=1
#
# 前置条件：
#   - 本机私钥可免密登录 NAS
#   - NAS 上 sudo 免密放行 /usr/local/bin/appcenter-cli
#
# 为什么不用 `appcenter-cli install-fpk`：对**已安装**的同名应用它是空操作
# （只打印 "Application [zt-note] is installed."，文件一个字节都不换），
# 必须用 `install-local -d <解包目录> -v <卷>` 才会真正替换（内部流程：停止 → 卸载 → 安装 → 启动）。
# 卸载 + 安装不会动 /usr/local/apps/@appdata/zt-note/workspace（笔记数据）。
set -e
cd "$(dirname "$0")/../.."

NAS="${NAS:-user@your-nas.local}"
NAS_PORT="${NAS_PORT:-2288}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/id_ed25519}"
NAS_VOL="${NAS_VOL:-1}"
SSH=(ssh -i "$NAS_KEY" -p "$NAS_PORT" -o BatchMode=yes -o ConnectTimeout=8 "$NAS")
SCP=(scp -i "$NAS_KEY" -P "$NAS_PORT" -o BatchMode=yes)

BUMP=1
[ "$1" = "--no-bump" ] && BUMP=

# 1) 打包
if [ -n "$BUMP" ]; then
  BUMP=1 bash deploy/fnos-app/pack.sh
else
  bash deploy/fnos-app/pack.sh
fi
VERSION="$(sed -n 's/^version=//p' deploy/fnos-app/zt-note/manifest | head -n1)"
FPK=deploy/fnos-app/zt-note.fpk
echo
echo "== 上传 zt-note $VERSION 到 $NAS"
"${SCP[@]}" "$FPK" "$NAS:/tmp/zt-note-$VERSION.fpk" >/dev/null
echo "   已上传 /tmp/zt-note-$VERSION.fpk"

# 2) 远端解包 + install-local（install-fpk 对已装应用无效）
echo "== 远端安装（install-local -v $NAS_VOL）"
"${SSH[@]}" "set -e
rm -rf ~/zt-pkg && mkdir -p ~/zt-pkg
tar xzf /tmp/zt-note-$VERSION.fpk -C ~/zt-pkg
sudo -n /usr/local/bin/appcenter-cli install-local -d \"\$HOME/zt-pkg\" -v $NAS_VOL 2>&1 \
  | tr '\r' '\n' | grep -vE '^[\\\\/|.-]* ?(Verifying|installing|uninstalling|starting|stopping)' | tail -5
sleep 3"

# 3) 验证
echo "== 验证"
"${SSH[@]}" "SOCK=/var/apps/zt-note/target/app.sock
echo -n '  已装版本: '; sudo -n /usr/local/bin/appcenter-cli list 2>&1 | awk -F'│' '/zt-note/{gsub(/ /,\"\",\$4); print \$4}'
echo -n '  health:   '; curl -s --unix-socket \$SOCK http://localhost/api/health
echo
for u in \$(curl -s --unix-socket \$SOCK http://localhost/ | grep -oE '(src|href)=\"[^\"]+\"' | sed -E 's/.*=\"([^\"]+)\"/\1/'); do
  curl -s --unix-socket \$SOCK -o /dev/null -w \"  静态资源 \$u -> %{http_code} %{content_type} %{size_download}B\n\" \"http://localhost/\${u#./}\"
done"
echo
echo "== 完成：desktop 打开「云记笔记」，或应用中心 → 云记笔记"
echo "   数据目录（笔记本体）: /usr/local/apps/@appdata/zt-note/workspace"
