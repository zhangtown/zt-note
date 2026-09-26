# 进度与待办

## 已完成（含验证证据）

| 阶段 | 内容 | 证据 |
|---|---|---|
| 0 | 笔记内容提取 | `示例工作区` 下转换脚本产出 12 篇 md + `全部笔记汇总.md` |
| 1 | 规格调研 | `docs/SIYUAN-FORMAT.md`、`docs/API.md`；FNOS 应用接入规范（网关、socket、`TRIM_*`） |
| 2 | 保真层 | `internal/siyuan/*`：`json.RawMessage` 保留原始节点、`changed:false` 原样复用 |
| 3 | 工作区服务 | `internal/store`：树、增删改查、搜索、导出；导入器三种形态 |
| 4 | HTTP + 网关闭环 | `internal/server`：`/api/*`、剥离前缀、`X-Trim-Isadmin` 鉴权、`api/health` |
| 5 | 保真校验 | `tools/sycheck`：12/12 篇 `.sy` 逐字节一致（227 块、22 资源） |
| 6 | 前端 | `ui/`（Vite + TipTap）：树/文档/编辑/搜索/导入导出；产物内嵌 `internal/webui/dist` |
| 7 | 接口级端到端 | `.test/e2e.py` 50/50 全绿（含“不改动直接保存 → 文件字节不变”、搜索 blockId 契约、资源上传/命名/引用改写） |
| 8 | UI 联调（严格模式） | `ui/scripts/e2e-live.mjs` 77/77 全绿：真实 Go 后端 + 无头 Chrome 走完「点开 → 编辑 → 保存 → 磁盘核对 → 无改动保存 → 搜索整篇/块定位 → 导出比对 → 粘贴上传图片」，报告 `ui/E2E-LIVE-REPORT.md` |
| 9 | 打包与实机部署 | `zt-note.fpk` 3.4 MB 已装到 your-nas.local（版本 0.1.1），12 篇真实笔记已导入并可读 |
| 10 | 图片与资源 | 编辑器粘贴/拖拽/按钮上传（`api/assets/upload`）；排版保真（`parent-style`/`style` 一行多图）；修掉“导入后图片全 404”（`internal/importer` 资源改名未改写引用） |

## 待办

- [ ] 实机逐篇点开核对渲染（已装可访问，人工校对未做）
- [x] 图片上传的 UI（粘贴/拖拽/「图片」按钮 → `api/assets/upload`，已接入）
- [x] 推送远端 + CI（`.github/workflows/ci.yml`：go / 前端 / fpk 三个 job）
- [ ] 块引用 / 块属性面板（`.sy` 里已保留原始字段，属于“读得懂写不回”）
- [ ] 表格编辑（当前只读渲染；思源表格属性不保留）
- [ ] 标签、书签、日记本等思源衍生块
- [ ] 多用户与权限（现在只区分管理员/非管理员，由网关决定）
- [ ] 定时/手动备份工作区（或写进 fpk 的 lifecycle 脚本）
- [ ] 移动端适配
- [ ] 编辑模式下的块级定位（现在搜索总是开阅读视图；编辑器 DOM 未带 `data-node-id`）

## 已知坑（都是踩过的）

- **`appcenter-cli install-fpk` 对已装应用是空操作**（即使版本号更高）：要升级必须
  `install-local -d <解包目录> -v <卷>`，详见 `deploy/README.md` 第 5 节
- **静态资源路径**：网关会给响应自动加 `/app/zt-note` 前缀，前端必须全部用 `./` 相对路径，
  否则 `assets/index-*.js` 会变成 `/assets/...` 而 404（`ui/scripts/e2e-live.mjs` 严格模式已固化断言）
- **搜索块定位**需要三件事同时成立：标题命中不带 `blockId`、正文命中带真实块 ID、
  阅读视图 HTML 带 `data-node-id`（缺一就会出现“跳转了但不高亮”）
- 改完前端必须重建 Go 二进制（`build.sh` 会自动判断）；`.test/` 与 `internal/webui/dist` 不入库
  （`internal/webui/dist/.gitkeep` 是唯一入库的文件：`go:embed all:dist` 要求目录存在）
- **导入资源必须按原名落盘**：文档里写的是 `assets/<原名>.png`，资源一改名（哪怕加了时间戳后缀）
  图片就全 404。`internal/importer/importer.go` 现在同名冲突时才生成新名字，并把文档、
  `NodeTextMark.TextHref` 里的引用一起改写（`internal/importer/importer_test.go` 卡住这条契约）
- **一行多图靠两件事同时成立**：`.sy` 里图片节点带 `parent-style: width: 25%;`，且渲染出的
  `div.img-rows` 里**不能有块间空白**（模板里的换行/缩进会把第 4 张挤到下一行，前端还要
  重复一遍这个包装逻辑——编辑器没有 `parent-style` 概念）

## 决策记录

- **Web 应用而非 Tauri**：fnpack 原样打包 `app/`，Tauri 需自带 bundle 布局，塞进去 ~80 MB 且脆；
  Web 版 8 MB 单二进制，网关模式免端口/免 TLS。代价：无托盘、无本地文件唤起
- **`.sy` 为唯一存储格式**：不发明中间格式，保证随时能回到思源
- **保真靠"原样复用"而不是"完善反序列化"**：未编辑块直接 `json.RawMessage` 回写，
  避免穷举思源字段（这是唯一能真正做到逐字节一致的路子）
- **图标用 Go 生成**（`tools/mkicon`）：不引入 Node/ImageMagick 依赖，4x 超采样抗锯齿
- **鉴权交给网关**：应用内不做账号体系，`allUsers:false` + `X-Trim-Isadmin`
- **图片排版属性双写**：思源把“一行几张”记在图片节点的 `parent-style: width:25%`、把原图宽度
  记在 `style: width:10000px`（靠 `max-width:100%` 收进容器）。两边都保真才能还原一行多图；
  编辑时这组默认值存在 docjson 的节点默认属性里（`ui/src/docjson.ts` 的 `defaultAttrs`）
