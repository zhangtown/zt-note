# 部署到飞牛 fnOS

## 1. 打包

```bash
cd <项目根>     # 或你在 Linux/macOS 上的项目根
bash deploy/fnos-app/pack.sh           # 已有前端产物时
bash deploy/fnos-app/pack.sh UI=1      # 先 cd ui && npm run build
```

脚本做四件事（幂等，可反复跑）：

1. `go run ./tools/mkicon -out deploy/fnos-app/zt-note` — 生成 `ICON.PNG`(64)、
   `ICON_256.PNG`(256) 和 `app/ui/images/icon_*.png`
2. （可选 `UI=1`）构建前端到 `internal/webui/dist`
3. `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w"` →
   `deploy/fnos-app/zt-note/app/bin/ztnote`
4. `fnpack build --directory deploy/fnos-app/zt-note` → `zt-note.fpk`

依赖：`fnpack` for Windows 放在 `.toolchain/fnpack/fnpack.exe`
（下载 `https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64`，`.toolchain/` 已在 .gitignore 里）。
注意 `.fpk` 是 **tar.gz**（fnpack 1.2.3），不是 zip，解包检查用 `tar tzvf`。

## 2. 安装到 NAS

两种方式任选：

**A. 应用中心手动安装**：把 `zt-note.fpk` 传到 NAS（共享文件夹或 `scp`），
飞牛桌面 → 应用中心 → 右上角「手动安装」→ 选择 fpk。

**B. 命令行**：

```bash
scp deploy/fnos-app/zt-note.fpk <user>@<nas>:/tmp/
ssh <user>@<nas>
sudo appcenter-cli install-fpk /tmp/zt-note.fpk     # 重装也是这条命令
```

装完在应用中心打开「云记笔记」（`zt-note`）。应用入口 `allUsers:false`，
当前只有管理员能看到；写操作要求网关注入的 `X-Trim-Isadmin: true`。

> NAS 的地址、账号、sudo 密码等凭据**不要写进仓库**，放在自己的密码管理器/本地备忘里。
> 本机直连调试（`-addr 127.0.0.1:8765`）不带任何鉴权头，服务端会放行写操作。

## 3. 运行期路径

| 用途 | 路径 |
|---|---|
| 工作区（笔记数据） | `$TRIM_PKGVAR/workspace` → `/vol1/@appdata/zt-note/workspace` |
| 数据文件 | `.../workspace/data/<boxID>/<docID>.sy`、`.../workspace/data/assets/` |
| 网关 socket | `$TRIM_APPDEST/app.sock`（app.sock 存在即网关模式） |
| 日志 | 应用中心 → 云记笔记 → 日志；或 `/vol1/@appdata/zt-note/…` 下 |

启动参数（一般不用改，走环境变量默认值）：
`-workspace`、`-addr`（TCP 调试）、`-sock`、`-prefix`（默认 `$GATEWAY_PREFIX` 或 `/app/zt-note`）。

## 4. 首次把笔记导进去

服务起来后，用本机直连端口（或网关地址）调一次导入：

```bash
# 服务器本地目录（推荐：先把思源 data 目录传上去）
curl -s -X POST http://<nas>:8765/api/import/path \
  -H 'Content-Type: application/json' \
  -d '{"path":"/vol1/1000/notes/data"}'

# 或上传思源导出的 zip / markdown zip
curl -s -X POST http://<nas>:8765/api/import/upload -F 'file=@siyuan-export.zip'
```

导入是复制语义：目录名即笔记本 ID，`.siyuan/conf.json` 提供笔记本名，
重名自动加 `-2`，源数据一个字节都不会被改。

## 5. 升级与回滚

- 升级：重新 `pack.sh` → 覆盖安装同一个 fpk（数据在 `@appdata` 里，不会被覆盖）
- 回滚：装回旧版 fpk；`.sy` 格式向后兼容，用思源直接打开工作区也能读
- 备份：直接备份 `/vol1/@appdata/zt-note/workspace/`，或用应用内「导出思源格式」下载 zip
