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
| 8 | UI 联调（严格模式） | `ui/scripts/e2e-live.mjs` 130/130 全绿：真实 Go 后端 + 无头 Chrome 走完「点开 → 编辑 → 保存 → 磁盘核对 → 无改动保存 → 搜索整篇/块定位 → 导出比对 → 粘贴上传图片 → 表格插入/增删行列/`.sy` 往返 → 手机视口（390×844）抽屉/面板/窄屏表格」，报告 `ui/E2E-LIVE-REPORT.md` |
| 9 | 打包与实机部署 | 已装到 your-nas.local，当前版本 0.5.0（`bash deploy/fnos-app/install.sh --no-bump` 一键升级；`install-fpk` 对已装应用无效，见下文坑）。实机核对（走应用 socket API）：12 篇文档、22 个资源、17 个图片节点请求全部 200，一行多图 `div.img-rows` 与块 `data-node-id` 正常，搜索标题命中按契约不带 `blockId`。发布：GitHub Release [`v0.5.0`](https://github.com/zhangtown/zt-note/releases/tag/v0.5.0) 附 `zt-note_0.5.0.fpk`（3,538,469 字节，SHA-256 `e9ed0322…`；tag 指向 `c0e53ce`） |
| 10 | 图片与资源 | 编辑器粘贴/拖拽/按钮上传（`api/assets/upload`）；排版保真（`parent-style`/`style` 一行多图）；修掉“导入后图片全 404”（`internal/importer` 资源改名未改写引用） |
| 11 | 表格编辑 | 思源 `NodeTable`/`NodeTableHead` ⇄ TipTap 表格双向映射（`internal/siyuan/pm.go` 的 `tableToPM`/`pmTableToSy`、`model.go` 的 `TableRows`/`TableColumns`/`TableSpan`）；插入 3×3 + 浮动操作条；`colgroup`/对齐/合并单元格往返。证据：`internal/siyuan/table_test.go` 全绿（含“只有 `NodeTableHead` 的表格不能丢表头行”“未改动表格 sha 不变”），前端逻辑测试 34/34，浏览器 e2e 20 项表格断言全绿 |
| 12 | 窄屏 / 手机适配 | 纯 CSS 媒体查询（阈值后来改 900px，见第 15 行）：侧栏改抽屉（`body.is-drawer-open` + `.drawer-mask`）、动作收进 ☰/⋯ 面板、目录行 38px / 工具条按钮 32px / 输入框 36px、搜索框与编辑区 ≥16px（免 iOS 聚焦缩放）、阅读与编辑区的表格 `display:block + overflow-x:auto` 自滚、编辑区 `calc(100dvh - 210px)`。新增 `ui/views/topbar.ts` 的 ☰/⋯ 与 `TopbarHandle.closePanels`。证据：e2e 第 13 节 25 项断言全绿（390×844 模拟手机，含“窄屏真插入表格并输入 → 保存后 `.sy` 是 NodeTable”、整页零横向溢出） |
| 13 | 多用户隔离 + PIN 锁 | 每个飞牛账号一份工作区（`$TRIM_PKGVAR/users/<uid>/workspace`，`internal/users`）；旧单用户库首启自动迁给 `1000`（幂等）；6 位 PIN（PBKDF2-HMAC-SHA256 12 万次 + 每用户盐，`users/<uid>/pin.json`）+ `ztnote_session` Cookie（HttpOnly、30 天、绑 uid）；未解锁时数据接口一律 401（标题/正文/图片都不下发）；首次解锁送《我的笔记》+ 欢迎文档；入口改 `allUsers:true` | `go test ./...` 29 个用例全绿（新增 `internal/users/users_test.go` 7 个 + `internal/server/session_test.go` 8 个：身份头解析/路径穿越/PIN 哈希不含明文/连错 5 次锁 1 分钟/令牌绑 uid/过隔离与 401 门）；浏览器 e2e 153/153（含「PIN 屏→解锁→锁定→错码→换账号」23 项）；前端逻辑 34/34。实机核对 0.5.0（your-nas.local 走应用 socket）：`health` 报告 `users:1`；身份 `1000/zhangtown` → `hasLibrary:true`（旧库迁移成功）、陌生身份 `9999` → `hasLibrary:false`（隔离）、未解锁 `/api/tree` → 401 `{"error":"locked"}`；用户实测浏览器：设 PIN → 12 篇笔记与图片都在（即飞牛网关确实注入了 `X-Trim-Userid`） |
| 14 | PIN 管理页（会话可见 + 撤销设备 + 闲置自动锁定） | `api/session` 增 `sessions`/`sessionExpiresAt`（`SessionManager.CountFor`/`Expires`，`DropUser` 开始返回注销数量）；新增 `POST api/pin/revoke`（作废该账号其它会话、本机换新令牌）；前端顶栏名字菜单新增「PIN 与安全…」面板——身份/本次解锁到期/已解锁设备/数据目录，自动锁定时长下拉（15/30/60/180/永不，存 `localStorage.zt.autolock.minutes`，默认 30 分钟），「修改 PIN」「撤销其它设备」「立即锁定」，以及「忘记 PIN」折叠指引（一键复制 `users/<uid>/pin.json` 路径）；新增 `ui/src/autolock.ts`（活动监听 + 闲置判定，纯函数可测）；到点自动锁定走 `api/pin/lock` 并提示「闲置太久，已自动上锁」 | `go test ./...` 31 个用例全绿（新增 `TestSessionCountAndExpiry`、`TestHTTPPinRevoke` 两个，PIN 门清单补 `/api/pin/revoke`）；前端逻辑 51/51（新增 17 项自动锁定用例）；浏览器 e2e 174/174（新增「3b-PIN管理」13 项：面板字段/5 档时长/localStorage 落盘/撤销后其它令牌 401/本机不受影响/菜单提示跟随设置；实机待验） |
| 15 | 品牌统一 + 移动端首页 | ① 统一「云记笔记」标识（`ui/src/logo.ts` 内联 SVG + CSS 类 `.logo-mark`，与应用图标 `tools/mkicon` 同款：深蓝渐变圆角方块 + 白书脊/白页 + 蓝线；`logoSvg`/`logoMark`/`logoDataUri`/`applyFavicon`），共用五处：`views/home.ts` 首页顶部、`views/gate.ts` PIN 门、`app.ts` 的 `bootError` 启动失败页、`app.ts` 的侧栏品牌行、favicon（`main.ts` 启动时注入 data URI）；`ui/index.html` 标题与启动文案改「云记笔记」。顶栏不再放品牌与 logo，回首页入口移到侧栏顶部品牌行（`.sidebar-brand`，窄屏即抽屉最上方）。② 修掉移动端首页「比屏幕稍微大一点」：根因是 `.shell` 没写 `grid-template-columns`，隐式列的 `auto` 最小宽被顶栏（约 870px 最小内容宽）撑开 → `.shell` 声明 `minmax(0,1fr)` + `.shell-body` 窄屏 `minmax(0,1fr)` + 搜索框 `flex:1 1 0`，窄屏断点 720→900（721–900 区间以前也横向溢出），首页 hero 在窄屏缩小内边距与标题字号 | `npm run build` + `check-build` 全过；`go test ./...` 31/31；前端逻辑 51/51；`npm run smoke` 6/6（顺手修好一个此前必挂的用例：静态服务器补一份假 `/api/session`，好让外壳在无后端时也能装配）；浏览器 e2e 176/176（新增「首页顶部是云记笔记标识 + 回首页入口在侧栏且顶栏无品牌」两项）。实测 320/360/390/414/740/820/900/901/1100/1180 均零横向溢出；手机视口截图核对抽屉、首页、阅读/编辑三处 |
| 16 | 修「还没有笔记本」误报 | 根因：首页空态横幅只在挂载那一烈算一次（文档树是异步加载的，那一刻 `store.tree` 还是 null），而每次重新加载树后没人通知视图。修法：`ViewHandle` 增可选 `refresh()`（`ui/src/views/doc.ts`），`ui/src/app.ts:117` 的 `refreshTree()` 里加 `current?.refresh?.()`（新建/重命名/删除/导入都走它，`ui/src/app.ts:382` 首帧也调一次），首页把横幅改成常挂节点（`ui/src/views/home.ts`），`syncBanner()` 按 `store.treeLoaded && !store.treeError && 无笔记本` 切 `is-hidden`（`treeLoaded` 是 `ui/src/views/tree.ts:154/156` 本来就有的标志） | 真实后端 + 手点：空工作区横幅出现 → 点「新建笔记本」后横幅 `is-hidden`（旧代码会一直挂着）；3 个笔记本 + 12 篇笔记的库冷启动不报（旧代码在这两份代码下都误报）；浏览器 e2e 176/176（首页断言全绿）；前端逻辑 51/51 |
| 17 | 修「手机 App / WebView 里 PIN 输对了仍旧反复要」 | 根因：飞牛 App 把应用嵌在 WebView/iframe 里，Cookie 被当第三方拦掉 ⇒ 解锁成功但下一个请求依旧未解锁。① 服务端令牌四通道（`internal/server/session.go`：`tokenHeader="X-Zt-Token"`、`tokenParam="token"`/`tokenParamShort="t"`、`Authorization: Bearer`、Cookie），`pin/setup|unlock|change|revoke` 响应体加 `token`，只读请求（GET/HEAD）才认 URL 令牌（写接口不认，防日志泄露），`/api/session` 未解锁时加 `reason`（`no_token`/`token_invalid`/`identity_changed`）与 `tokenUid`；② 前端 `ui/src/api.ts` 保存/携带/清理令牌（`localStorage.ztnote.token` + 请求头 + 只读 `?t=`），`ui/src/views/gate.ts` 解锁后当场复查会话，令牌没立住就把原因与 uid 写在 PIN 屏上（不再无声重问），`ui/src/views/doc.ts` 图片/导出挂 `?t=`。 | `go test ./...` 全绿（新增 `internal/server/token_test.go` 6 个用例：头/URL 通道、写接口拒 URL 令牌、reason 三态、跨 uid 失效）；前端逻辑 67/67；浏览器 e2e 178/178（新增「.sy 不写令牌」断言；图片 src 断言允许 `?t=`）；新增 `.test/webtest-pin.mjs` 三个场景实机验证（Cookie 罐每 50ms 清空 / 同时禁用 localStorage / Cookie 正常）均「PIN 进去→/api/tree 200→文档内图片 6/6 显示」，且解锁后 0 个 401 |

## 待办

- [ ] 实机逐篇点开核对渲染（已装可访问，人工校对未做）
- [x] 图片上传的 UI（粘贴/拖拽/「图片」按钮 → `api/assets/upload`，已接入）
- [x] 推送远端 + CI（`.github/workflows/ci.yml`：go / 前端 / fpk 三个 job）
- [x] 移动端适配（窄屏抽屉 + 动作面板 + 表格自滚 + 触控尺寸，e2e 第 13 节覆盖；阈值后续改 900px）+ 品牌统一（云记笔记标识、回首页入口）
- [x] 修「还没有笔记本」误报（树加载完通知视图刷新，首页空态横幅不再挂错）
- [ ] 块引用 / 块属性面板（`.sy` 里已保留原始字段，属于“读得懂写不回”）
- [x] 表格编辑（思源 `NodeTable`/`NodeTableHead` ⇄ TipTap 表格；插入、增删行列、表头行、`.sy` 往返）
- [ ] 标签、书签、日记本等思源衍生块
- [x] PIN 管理页（「PIN 与安全…」面板：会话状态、自动锁定、撤销其它设备、忘记 PIN 指引；后端 `api/pin/revoke`）
- [ ] 每用户配额/存储占用提示
- [ ] 实机验证两个普通账号互相看不到对方的库（开发环境已用两个身份头验过）
- [ ] 定时/手动备份工作区（或写进 fpk 的 lifecycle 脚本）
- [ ] 编辑模式下的块级定位（现在搜索总是开阅读视图；编辑器 DOM 未带 `data-node-id`）

## 已知坑（都是踩过的）

- **`appcenter-cli install-fpk` 对已装应用是空操作**（即使版本号更高）：要升级必须
  `install-local -d <解包目录> -v <卷>`，详见 `deploy/README.md` 第 5 节
- **静态资源路径**：网关会给响应自动加 `/app/zt-note` 前缀，前端必须全部用 `./` 相对路径，
  否则 `assets/index-*.js` 会变成 `/assets/...` 而 404（`ui/scripts/e2e-live.mjs` 严格模式已固化断言）
- **实机核对只能走应用的 socket API**：工作区目录属 app 用户，SSH 进来读不到（`sudo -n` 只放行了
  `appcenter-cli`）。可用的路子：`curl --unix-socket /var/apps/zt-note/target/app.sock http://localhost/api/...`；
  要看资源清单就导一份 `api/export/siyuan` 的 zip 再列条目。注意 `ok()` 把字段**平铺在顶层**（不是 `data` 包一层）
- **资源名里可能有空格/中文**（思源截图常见）：核对资源是否能 200 时必须做百分号编码，
  否则 curl 传空格会得到 `000` 而不是 404，看起来像坏引用（浏览器会自动编码，不影响实际使用）
  阅读视图 HTML 带 `data-node-id`（缺一就会出现“跳转了但不高亮”）
- 改完前端必须重建 Go 二进制（`build.sh` 会自动判断）；`.test/` 与 `internal/webui/dist` 不入库
  （`internal/webui/dist/.gitkeep` 是唯一入库的文件：`go:embed all:dist` 要求目录存在）
- **导入资源必须按原名落盘**：文档里写的是 `assets/<原名>.png`，资源一改名（哪怕加了时间戳后缀）
  图片就全 404。`internal/importer/importer.go` 现在同名冲突时才生成新名字，并把文档、
  `NodeTextMark.TextHref` 里的引用一起改写（`internal/importer/importer_test.go` 卡住这条契约）
- **一行多图靠两件事同时成立**：`.sy` 里图片节点带 `parent-style: width: 25%;`，且渲染出的
  `div.img-rows` 里**不能有块间空白**（模板里的换行/缩进会把第 4 张挤到下一行，前端还要
  重复一遍这个包装逻辑——编辑器没有 `parent-style` 概念）
- **思源表格的权威结构去查 Lute 源码**：`node/table.go`/`table_row.go`/`table_cell.go` +
  `parse/table.go` + `render/html.go`（v1.7.8）——表头行在 `NodeTableHead` 里、`colgroup` 缺列要按
  `|` 补空列、单元格直接存行内节点（没有 `NodeParagraph`）。别照着自己的 `.sy` 猜格式
- **发 Release 的包由 CI 构建（Go 1.24）**：本地 go-sdk 是 1.27，同一份源码编出来
  二进制 8.29 MB / 包 3.5 MB，CI（1.24）是 7.45 MB / 3.1 MB——都能跑，但**别拿本地手工编的
  包去顶 Release 附件**（会和说明里的 SHA-256、CI 产物不一致）。发版就 `git tag vX.Y.Z &&
  git push --tags` 或跑 `release.yml` 的 workflow_dispatch
- **`gh release upload` 的 `file#label` 只改显示标签，不改资源名**：想要带版本号的附件名
  （`zt-note_0.5.0.fpk`）得先把文件复制成那个名字再上传（`release.yml` 里已经踩过这个坑）
- **e2e 一直在拿旧前端跑（已修）**：`ui/scripts/e2e-live.mjs` 的 `newestMtime()` 把 `dist` 当垃圾目录忽略了，而
  `internal/webui/dist` 正是被 `go:embed` 进二进制的产物 —— 改完前端不重建二进制（复用了旧的）就直接拿旧 UI 断言，
  会看到“已经改过的旧文案/旧行为”，白白排查一轮。现在：① `dist` 不再进忽略名单；② 跑 e2e 前会自动比较
  `ui/src+ui/index.html` 与 `internal/webui/dist` 的 mtime，过期就先 `npm run build`（报告第 1 节会写明是复用还是重建）
- **`cdp.clickElement(expr)` 收的是 JS 表达式不是 CSS 选择器**（自己写 UI 测试脚本时的坑）：
  传 `'.foo'` 会当成表达式报 `SyntaxError`，要传 `document.querySelector('.foo')`

## 决策记录

- **Web 应用而非 Tauri**：fnpack 原样打包 `app/`，Tauri 需自带 bundle 布局，塞进去 ~80 MB 且脆；
  Web 版 8 MB 单二进制，网关模式免端口/免 TLS。代价：无托盘、无本地文件唤起
- **`.sy` 为唯一存储格式**：不发明中间格式，保证随时能回到思源
- **保真靠"原样复用"而不是"完善反序列化"**：未编辑块直接 `json.RawMessage` 回写，
  避免穷举思源字段（这是唯一能真正做到逐字节一致的路子）
- **图标用 Go 生成**（`tools/mkicon`）：不引入 Node/ImageMagick 依赖，4x 超采样抗锯齿
- **鉴权交给网关 + 按 uid 分库**：应用不做账号体系，身份全靠网关注入的 `X-Trim-Userid`；
  入口 `allUsers:true`，安全边界是「每用户一份独立工作区」，不是管理员头
- **PIN 只守浏览入口，不碰内容**：6 位数字 + PBKDF2 + 服务端 401（未解锁连标题都不发），
  但磁盘上仍是明文 `.sy` —— 不把“应用层 PIN”包装成“加密”
- **图片排版属性双写**：思源把“一行几张”记在图片节点的 `parent-style: width:25%`、把原图宽度
  记在 `style: width:10000px`（靠 `max-width:100%` 收进容器）。两边都保真才能还原一行多图；
  编辑时这组默认值存在 docjson 的节点默认属性里（`ui/src/docjson.ts` 的 `defaultAttrs`）
- **表格用 TipTap 官方四个扩展而不是自造表格节点**：这样 schema 里就有真的 `table` 节点，
  新的 sanitizer 不会再把它降级成段落；代价是列宽编辑只能做到“按位置保留 `colgroup`”
- **新表格不写 `colgroup`/`cols`**：让思源自己决定默认列宽，写死了反而会在窄屏/不同字体下难堪
