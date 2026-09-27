# zt-note · 飞牛 NAS 笔记应用

自建的笔记应用，跑在飞牛 fnOS 上，**原生存储格式就是思源笔记的 `.sy`（JSON）**：
可以直接导入思源工作区，编辑后导出的 `.sy` 能与原文件**逐字节一致**地还原回思源，
数据不锁死在应用里。

- **形态**：fnOS 原生应用（`.fpk`）；Go 单二进制（8 MB）+ 内嵌前端（Vite + TipTap）
- **访问**：应用中心安装后打开即用；经飞牛统一网关挂在 `/app/zt-note`，鉴权交给网关
- **存储**：工作区目录下，一个笔记本 = 一个目录，一篇文档 = 一个 `.sy` 文件
  （默认 `$TRIM_PKGVAR/workspace`，即 `/vol1/@appdata/zt-note/workspace`）

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
.test/ztnote.exe -workspace .test/workspace -addr 127.0.0.1:8765

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

CI（`.github/workflows/ci.yml`）：Go vet + 单测、前端类型检查/build/逻辑测试、`build.sh all`
产 fpk 并作为 artifact 上传。`internal/webui/dist` 不入库，仓库里只放一个 `.gitkeep`
（`go:embed all:dist` 要求目录存在；缺 `index.html` 时 `webui.Available()` 为 false）。

## 数据与导入

支持三种导入方式，全部只读源、不修改原始数据（重名自动加 `-2`、`-3` 后缀）：

| 形式 | 内容 |
|---|---|
| 思源工作区目录 | `data/<boxID>/<docID>.sy` + `.siyuan/conf.json`（取笔记本名）+ `data/assets/` |
| 思源导出 zip | 同上（可带一层 `data/` 前缀） |
| Markdown | `<笔记本>/<标题>.md` + `assets/`；单个 `.md`（如「全部笔记汇总.md」）按一级标题拆成多篇 |

搜索结果支持块级定位：标题命中打开整篇文档，正文命中会跳转并高亮命中块
（阅读视图的每个块带 `data-node-id`，见 [`docs/API.md`](docs/API.md) 的 `api/search` 契约）。

导出两种格式：`api/export/siyuan`（`data/<box>/<doc>.sy` + `assets/`，可直接解开覆盖回
思源工作区）、`api/export/md`。

图片按原名导入（同名冲突才改名，并同步改写文档里的 `assets/...` 引用——否则 `.sy` 里的
图片会全部 404）。

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

## 手机 / 窄屏

窗口宽度 ≤720px（手机浏览器、竖屏小窗）时自动切换布局，全部由 CSS 媒体查询驱动，不改变桌面形态：

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

## 目录结构

```
cmd/ztnote/          进程入口：socket/TCP 监听、工作区、前缀
internal/siyuan/     .sy 读写与保真层（model/render/pm/markdown/base64）
internal/store/      工作区服务：文档树、增删改查、搜索、导出
internal/importer/   导入（siyuan / markdown / 汇总 md 拆分）
internal/server/     HTTP 路由与网关鉴权
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
- 应用内无账号体系：写操作要求网关注入 `X-Trim-Isadmin: true`（本机直连无该头时放行）
