# zt-note · 飞牛 NAS 笔记应用

自建的笔记应用，跑在飞牛 fnOS 上，**原生存储格式就是思源笔记的 `.sy`（JSON）**：
可以直接导入思源工作区，编辑后导出的 `.sy` 能与原文件**逐字节一致**地还原回思源，
数据不锁死在应用里。

- **形态**：fnOS 原生应用（`.fpk`）；Go 单二进制（8 MB）+ 内嵌前端（Vite + TipTap）
- **访问**：应用中心安装后打开即用；经飞牛统一网关挂在 `/app/zt-note`，身份用网关的账号，进应用再过一个 6 位 PIN
- **多用户**：每个飞牛账号一份独立笔记库（`users/<uid>/workspace`），互相看不见
- **存储**：工作区目录下，一个笔记本 = 一个目录，一篇文档 = 一个 `.sy` 文件
  （默认 `$TRIM_PKGVAR/users/<uid>/workspace`，即 `/vol1/@appdata/zt-note/users/1000/workspace`）

## 为什么是 Web 应用而不是 Tauri

最初考虑 Tauri 原生客户端，最终放弃：fnpack 是把 `app/` 目录原样打包，Tauri 需要自己的
bundle 布局，硬塞进去又大（~80 MB）又脆；而 Web 应用只需要一个静态二进制 + 静态资源，
8 MB，网关模式下无需关心端口和 TLS。**代价是没有系统托盘/本地文件唤起**，
以后若确实需要，可再做一个瘦客户端壳接同一套 HTTP API。

## 保真策略（这个项目的核心）

回写 `.sy` 时"重新生成整个 JSON"极容易丢字段（属性、块 ID、未知属性、时间戳……）。
zt-note 的做法是把保真做成默认路径：

1. 解析 `.sy` 时**不整体反序列化成结构体**，而是把每个顶层的块节点原样保存为
   `json.RawMessage`（见 `internal/siyuan/model.go`）。
2. 前端加载文档时，每个块带上块 ID 与它对应的 ProseMirror JSON；**未修改的块标记
   `changed:false`，后端直接复用磁盘上的原始节点**，一个字节都不重新序列化。
3. 只有真正编辑过的块（`changed:true`）才用 `pm` 重新生成节点，且**保留原块 ID**。
4. 保存时如果整篇文档没有任何变化，请求不写盘，文件字节与 mtime 都不动。

已验证：12 篇真实笔记（227 个块）经过"导入 → 加载 → 保存 → 导出"后，
`.sy` 与原始文件 **12/12 逐字节相同**（`tools/sycheck`）。后端另有 50 项接口级
端到端断言（`.test/e2e.py`）。

## 快速开始（开发）

```bash
bash build.sh                       # 建 Windows 开发二进制（前端源码更新时自动重建前端）
.test/ztnote.exe -data .test/data -addr 127.0.0.1:8765

# 前端热更新（vite proxy 到 8765），开发时不需要 build.sh
cd ui && npm ci && npm run dev
```

前端构建产物直接输出到 `internal/webui/dist`，由 Go 二进制 `go:embed` 打进包里
（所以改前端后必须重新构建 Go 二进制才会生效）。

```bash
cd ui && npm run build     # tsc + vite build + 产物检查
npm run test:logic         # 纯逻辑测试（docjson 双向转换）
npm run smoke              # 无头 Chrome 冒烟（无后端）
npm run e2e:live           # 真实后端 + 无头浏览器联调
```

## 构建与部署（fnOS）

```bash
bash build.sh fpk                     # 生成图标 → 编译 linux/amd64 → 产出 zt-note.fpk
bash build.sh fpk UI=1                # 强制先重建前端
bash deploy/fnos-app/install.sh       # 打包 + 上传 + 安装/升级 + 验证（NAS 地址见部署文档）
```

产物：`deploy/fnos-app/zt-note.fpk`（约 3.4 MB）。安装、升级（注意 `install-fpk` 对已装应用
无效这个坑）与 NAS 部署步骤见 [`deploy/README.md`](deploy/README.md)。

不想自己构建就直接下：**[Releases](https://github.com/zhangtown/zt-note/releases)** 里有每个版本
的 `zt-note_x.y.z.fpk`（飞牛 → 应用中心 → 手动安装），附件附 SHA-256。
注意仓库是私库，下载需要在浏览器里登录有权限的 GitHub 账号。

CI（`.github/workflows/ci.yml`）：Go vet + 单测、前端类型检查/build/逻辑测试、`build.sh all`
产 fpk 并作为 artifact 上传。`internal/webui/dist` 不入库，仓库里只放一个 `.gitkeep`
（`go:embed all:dist` 要求目录存在；缺 `index.html` 时 `webui.Available()` 为 false）。

发版（`.github/workflows/release.yml`）：`git tag vX.Y.Z && git push --tags` —— 跑一遍测试 →
打包 → 建/更新对应的 GitHub Release 并挂上 `zt-note_X.Y.Z.fpk`（带大小与 SHA-256）。
发布说明里手写的部分放 `docs/releases/X.Y.Z.md`（可选），自动生成部分包含下载/安装提示、
校验和与「本次包含的提交」。tag 与 `deploy/fnos-app/zt-note/manifest` 里的 `version` 必须一致，
不一致会直接失败（避免挂错包）。

## 数据与导入

支持三种导入方式，全部只读源、不修改原始数据（重名自动加 `-2`、`-3` 后缀）：

| 形式 | 内容 |
|---|---|
| 思源工作区目录 | `data/<boxID>/<docID>.sy` + `.siyuan/conf.json`（取笔记本名）+ `data/assets/` |
| 思源导出 zip | 同上（可带一层 `data/` 前缀） |
| Markdown | `<笔记本>/<标题>.md` + `assets/`；单个 `.md`（如「全部笔记汇总.md」）按一级标题拆成多篇 |

搜索支持块级定位：标题命中打开整篇文档，正文命中会跳转并高亮命中块
（阅读视图的每个块带 `data-node-id`；编辑视图用 ProseMirror 装饰器高亮——
手改 DOM 属性会被编辑器重绘抹掉，装饰器才是扛得住重绘的那条路。契约见 [`docs/API.md`](docs/API.md) 的 `api/search`）。

导出两种格式：`api/export/siyuan`（`data/<box>/<doc>.sy` + `assets/`，可直接解开覆盖回
思源工作区）、`api/export/md`。

图片按原名导入（同名冲突才改名，并同步改写文档里的 `assets/...` 引用——否则 `.sy` 里的
图片会全部 404）。

## 多用户与 PIN

每个飞牛账号一份**独立笔记库**，互不可见：网关把账号身份注入 `X-Trim-Userid`，应用按它选工作区
`$TRIM_PKGVAR/users/<uid>/workspace`（本机直连无该头时用一个叫 `local` 的身份）。

首次打开要先设一个 **6 位 PIN**，之后每次进入都要解锁：

- 未解锁时服务端对所有数据接口返 `401`——**标题、正文、图片一律不下发**，不是前端遮一下
- 解锁状态默认存在 `ztnote_session` Cookie（HttpOnly，30 天，令牌绑 uid）；顶栏名字菜单里有「**PIN 与安全…**」：改 PIN、自动锁定、撤销其它设备、锁定
- **飞牛 App（手机端/桌面客户端）**把应用嵌在 WebView / iframe 里，可能把 Cookie 当第三方拦掉。
  这种环境里令牌改走请求头 `X-Zt-Token`（存在浏览器 localStorage），图片与导出走只读的 `?t=` 参数；
  解锁后前端会当场复查一次会话，没立住就直接把原因写在 PIN 屏上（是用错账号 / 凭证失效 /
  浏览器没留住凭证），而不是让同一串数字反复输。详见 `docs/API.md` 的「会话与 PIN」
- **闲置自动锁定**：多久不动就回到 PIN 屏（15 分钟 / 30 分钟（默认）/ 1 小时 / 3 小时 / 永不），时长按设备存在浏览器里，手机可以设短一点
- **撤销其它设备**：手机丢了、在别人电脑上忘了锁 —— 一键作废其它设备上的解锁（它们需要重新输 PIN），本机不受影响；改 PIN 也会顺手作废其它设备
- PIN 存在 `users/<uid>/pin.json`：PBKDF2-HMAC-SHA256（12 万次迭代）+ 每用户随机盐，不存明文；
  连错 5 次起逐级锁定（1 分钟 → 5 分钟 → 15 分钟）
- **忘了 PIN**：删掉 `users/<uid>/pin.json` 即可重设（笔记、图片、表格都在 `workspace/`，一个字也不会动）；
  路径在「PIN 与安全…」面板里有一键复制
- 首次解锁会送一个《我的笔记》笔记本和一篇欢迎文档，顺手写请怎么用
- 升级：旧版单用户目录 `workspace/` 首次启动自动迁到 `users/1000/workspace`（幂等，日志有记录）

要说清楚的是：**PIN 是防旁人随手翻看的门，不是加密**。磁盘上仍是明文 `.sy`，真要抗物理访问
得靠卷加密或整盘加密；这个应用不碰那些。

## 图片

- **上传**：编辑器里直接粘贴、拖拽，或用工具条的「图片」按钮 → `api/assets/upload` → 插入图片节点
- **格式**：写成思源原生形态——`NodeImage{parent-style,style}` 包一个 `NodeLinkDest`，
  `alt` 是原文件名；不存私有字段，导出回思源依然是思源图片
- **排版**：`parent-style: width:25%` 决定一行几张（四张就是一行四张），`style` 是原图宽度，
  靠 `max-width:100%` 收进容器；阅读视图与编辑器都按这套规则还原

## 表格

- **结构**：思源表格就是 Lute 的 `NodeTable`——首行表头放在 `NodeTableHead` 下，列宽写在
  `Properties.colgroup`（`|` 补空列），对齐写在 `Properties.cols`（`L/C/R`），合并信息存在单元格的
  `colspan`/`rowspan` 上。前端用 TipTap 官方四个表格扩展，不自造模型
- **编辑**：工具条「表格」插入 3×3（首行表头）；光标在表内时浮出操作条：右侧插列、下方插行、
  删行、删列、表头行切换、删除表格。
- **保真**：没动过的块整块原样复用（`changed:false`）；动过的表格把 `colgroup`/对齐/`colspan`
  按位置写回；新建表格不写 `colgroup`，由思源按默认列宽显示

## 编辑与右键菜单

- **打开就能改**：没有「编辑」按钮，点进文档就是所见即所得（TipTap / ProseMirror），点哪儿改哪儿
- **自动保存**：停手约 0.9s 就写盘；连续打字时最快每 4s 写一次、最长 15s 也会强制落一次盘
  （`ui/src/views/doc.ts` 的 `IDLE_MS` / `MIN_GAP_MS` / `MAX_DELAY_MS`），没有「保存」按钮
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Shift+Z`（macOS `⌘Z` / `⌘⇧Z`），工具条与正文右键菜单里也有
- **状态有交代**：页头状态行显示「已保存 14:03」「正在保存…」「有未保存的改动…」，写失败变红并给
  「重试」；关闭页面前（`pagehide`）还会兜底再存一次（`keepalive`）
- **侧栏右键**：笔记本与文档上右键（触屏是行尾 `⋯`）→ 新建笔记 / 重命名 / 删除；笔记本名与
  文档标题也能直接双击就地改（回车提交、Esc 取消）。删笔记本会连带删掉它目录下的所有 `.sy`，
  所以走的是红按钮二次确认；系统目录（`assets`、`templates`、`storage` 等）与非法 id 一律拒绝
- **正文右键**：加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 清除格式 / 链接、标题 1-3 / 正文、
  无序 / 有序 / 任务列表 / 引用 / 代码块 / 分割线、插入表格 / 图片、撤销 / 重做（共 21 项，带快捷键提示）。
  条目多，所以默认排成**两列**（约 372×363px，比单列 700+px 少占一屏）；宽度不够时（如 320px 窄屏）
  `views/menu.ts` 会量一次真实内容宽自动退回单列并在菜单内滚动，不靠拍脑袋的媒体查询断点
- **右键不动选区**：点在已有选区**内部**时保留选区（「选中一段 → 右键 → 加粗 / 引用」才有对象），
  点在选区**外面**才把光标挪过去（「在这里插表格」这类命令靠它定位）；`editor.ts` 的
  `handleDOMEvents.mousedown` + `contextmenu` 两处一起管这事，`Ctrl+B`/工具条走的是同一批命令

## 品牌标识

「云记笔记」标识是 `ui/src/logo.ts` 里的一段内联 SVG（与应用图标 `tools/mkicon` 同款：深蓝渐变圆角方块 + 白色书脊与纸页 + 蓝色文字线；
矢量而非位图，任何尺寸清晰，不额外请求文件）。用到的地方：首页顶部（`views/home.ts`）、PIN 门（`views/gate.ts`）、
启动失败页（`app.ts` 的 `bootError`），以及 favicon（`main.ts` 启动时 `applyFavicon()` 注入 data URI）。
顶栏与侧栏都不再放 logo/品牌名（首页 hero 里已经有，重复）——顶栏的宽度留给目录按钮与搜索框，
侧栏顶部是「🏠 首页」导航项（`app.ts` 的 `.tree-nav-item`），它是顶栏去掉品牌后唯一的回首页入口。

## 手机 / 窄屏

窗口宽度 ≤900px（手机浏览器、竖屏小窗、窄桌面窗口）时自动切换布局，全部由 CSS 媒体查询驱动，不改变桌面形态。
阈值取 900 而不是更小：顶栏那一排按钮加搜索框的最小内容宽约 870px，窗口再窄就没法用桌面版顶栏了：

- **回首页**：顶栏不放品牌，回首页入口是侧栏顶部的「🏠 首页」行（窄屏就在抽屉最上方）

- **目录变抽屉**：左侧栏 `position:fixed` 滑入，顶栏出现 ☰ 开关；点遮罩或选中文档自动收起
- **顶栏收纳**：只留 ☰ / 搜索框 / ⋯；新建、重命名、删除、导入、导出都收进 ⋯ 面板（竖排 40px 高按钮）
- **触控尺寸**：目录行 38px、工具条按钮 32px、输入框 36px 高；交互元素加 `touch-action: manipulation`
- **免 iOS 缩放**：搜索框与编辑区在窄屏下字号 ≥16px（小于 16px 时 iOS 聚焦会自动放大页面）
- **宽表格自己滚**：阅读视图与编辑区的 `table` 都是 `display:block; width:max-content; max-width:100%; overflow-x:auto`，
  列多的时候在表格框里横滑，不会把整页撑宽（编辑区照样能点单元格、能输入）
- **编辑区高度**：`calc(100dvh - 210px)`（带 `100vh` 回退），宽度靠视口而不是桌面窗口
- 轻提示贴底边、弹窗占满可用宽度

验证：`ui/scripts/e2e-live.mjs` 第 13 节用 CDP `Emulation.setDeviceMetricsOverride` 模拟 390×844 手机视口，
走完「抽屉开合 / 遮罩 / 面板展开 / 从抽屉选文档 / 无横向溢出 / 窄屏插入表格并输入 / 保存后 `.sy` 核对」共 25 项断言。
宽度 320 / 360 / 390 / 414 / 740 / 820 / 900 / 901 / 1100 / 1180 实测整页 `scrollWidth == clientWidth`（零横向溢出）。

## 目录结构

```
cmd/ztnote/          进程入口：socket/TCP 监听、工作区、前缀
internal/siyuan/     .sy 读写与保真层（model/render/pm/markdown/base64）
internal/store/      工作区服务：文档树、增删改查、搜索、导出
internal/importer/   导入（siyuan / markdown / 汇总 md 拆分）
internal/users/      多用户：网关注入身份解析、每用户工作区、旧库迁移、PIN 存储
internal/server/     HTTP 路由、网关鉴权、会话/PIN 门
internal/webui/      前端产物 go:embed
ui/                  Vite + TypeScript + TipTap 前端
tools/sycheck/       保真校验器（对比原始/回写的 .sy）
tools/mkicon/        图标生成（纯 Go 绘图，无依赖）
deploy/fnos-app/     fpk 包骨架 + pack.sh
docs/API.md          前后端接口契约
docs/SIYUAN-FORMAT.md  .sy 格式说明与字段映射
docs/PROGRESS.md     进度与待办
```

## 已知边界

- 表格：结构编辑、`colgroup` 列宽、对齐、合并单元格（`colspan`/`rowspan`）都能往返；但没有
  拖拽调宽和「合并/拆分单元格」按钮，思源里手动合并过的表格在插删行列后可能错位
- 图片：粘贴/拖拽/上传与 `parent-style` 排版已保真；思源里手动拖过尺寸的图片不还原像素级宽度
  （`style` 原值会写回，但编辑时前端不提供拖拽改尺寸）
- 代码块：语言、折行等以原字段为准；未编辑时整个节点原样复用
- 未实现：块引用/块属性面板、标签与书签、图纸/数据库等衍生块类型的编辑
- 应用内没有账号体系：身份由网关（飞牛账号）决定，密码也就是飞牛的；应用自己只有 6 位 PIN
  （只守浏览入口，不加密数据）

## 许可证

[MIT](LICENSE) © 2026 zhangtown。可以随意使用、修改、再发布（含商用），保留版权声明即可。

项目里用到的第三方组件仍是它们自己的许可：前端编辑器 TipTap / ProseMirror（MIT）、构建链
Vite + TypeScript（MIT）、后端只用 Go 标准库（BSD-3-Clause）。发布的 `.fpk` 里跑的就是这些依赖
的打包产物。飞牛 fnOS 的包格式（`manifest` / `app.tgz` / `appcenter-cli`）使用方式以飞牛官方说明为准。
