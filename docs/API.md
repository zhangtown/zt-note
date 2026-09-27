# zt-note API 契约 v1

服务端：Go 单二进制，监听 Unix socket（`$TRIM_APPDEST/app.sock`）或开发时 TCP `127.0.0.1:8765`。
经 fnOS 统一网关访问时路径带前缀 `/app/zt-note`（服务端自动剥离）；开发直连无前缀。

前端一律使用**相对路径**（页面 URL 为 `/app/zt-note/` 或 `http://host:8765/`），
`fetch('api/tree')`、`<img src="assets/xx.png">` 均可正确解析。路由用 hash（`#/doc/<box>/<id>`）。

响应统一 `{"ok":true,...}` / 出错 `{"ok":false,"error":"..."}`（HTTP 4xx/5xx）。

## 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/health` | `{ok,version,dataRoot,prefix,frontend,user,needsPin,locked,users,dataDir?,stats?}`（未解锁时不下发 `dataDir`/`stats`） |
| GET | `api/tree` | `{notebooks:[{id,name,icon,docs:[{id,title,updated,children:[...]}]}]}` |
| GET | `api/doc?box=<boxID>&id=<docID>` | `{id,box,title,updated,readonly,html,blocks:[{id,type,level?,pm}]}` |
| GET | `api/search?q=<词>&limit=50` | `{hits:[{box,id,title,blockId,snippet}]}`（标题+正文，忽略大小写） |
| GET | `assets/<文件>` | 图片等资源（来自 `data/assets/`） |

`blocks[].pm` 为该块的 ProseMirror 节点 JSON（TipTap 顶层节点），`type` 为对应的
`paragraph|heading|codeBlock|blockquote|bulletList|orderedList|image|thematicBreak|table`。

`html` 字段是后端渲染的阅读视图，**每个顶层块的首个标签带 `data-node-id="<块 ID>"`**
（`internal/siyuan/render.go` `RenderBlocksHTML` + `withNodeID`）。前端搜索结果定位就靠它
（`ui/src/views/doc.ts` `highlightBlock` → `[data-node-id=...]`），HTML 导出也带同样的标记。

`hits[].blockId` 的契约（前端据此决定「整篇命中」还是「定位到块」）：

| 命中位置 | `blockId` | 前端行为 |
|---|---|---|
| 文档标题（= 整篇命中） | `""`（空串） | 卡片提示「整篇命中，点击打开」，不带 `?block=`、不做块级高亮 |
| 正文块 | 该块的块 ID（必是文档内真实存在的块） | 卡片提示「定位到块 <id>」，跳转带 `?block=<id>` 并高亮该块 |

注意：思源的文档 ID 不是任何块的 `data-node-id`，所以标题命中**不能**填 `doc.ID`，
否则前端会定位到一个不存在的块（已由 `.test/e2e.py` 与 `ui/scripts/e2e-live.mjs` 固化断言）。

## 写入

| 方法 | 路径 | body |
|---|---|---|
| POST | `api/doc/save` | `{box,id,blocks:[{id,pm,changed:bool,type}]}` → `{id,blocks:[{id,type,pm}],html,…}` |
| POST | `api/doc/create` | `{box,title,parentId?}` → `{id}` |
| POST | `api/doc/rename` | `{box,id,title}` |
| POST | `api/doc/delete` | `{box,id}` |
| POST | `api/notebook/create` | `{name}` → `{id}`（重名自动加 “ 2”） |
| POST | `api/notebook/rename` | `{id,name}` |
| POST | `api/notebook/delete` | `{id}`（连目录一起删，不可恢复） |
| POST | `api/assets/upload` | multipart `file` → `{name,url}` |
保存语义：`changed:false` 的块按 `id` 复用原始 .sy 节点；`changed:true` 的块按 `pm` 重新生成
（保留块 ID）；`blocks` 中缺失的块视为删除；顺序以 `blocks` 数组为准。后端刷新 `updated`。
响应回显**保存后的块表**（新建块的真实 `id` 在这里），前端用它更新下一轮比对的基准 —— 新块
不能永远以 `id:null` 回传，否则每存一次都会多出一份。

笔记本的 `create`/`rename`/`delete`（`internal/store/store.go`）：`id` 必须是合法思源笔记本 ID，
且不能是系统目录（`assets`/`templates`/`storage`/`widgets`/`plugins`/`emojis`、以 `.` 开头、以及工作区根目录），
否则 **400**；目标不存在（或同名路径不是目录）**404**；`rename` 只改 `.siyuan/conf.json` 的 `name`
（其它字段原样保留），空名字 **400**；`create` 重名不报错，把名字写成「名字 2」。响应体统一是
`{ok:false,error:"..."}` / `{ok:true,...}`（见 `internal/server/notebook_test.go`）。

## 图片与资源

| 环节 | 契约 |
|---|---|
| 上传 | `POST api/assets/upload`（multipart `file`）→ `{name,url}`；落盘到工作区 `data/assets/`，重名自动加 `-<yyyyMMddHHmmss>-<rand>` 后缀 |
| 显示 | 图片 URL 就是 `assets/<name>`（经静态路由 `/assets/`，网关模式下带 `/app/zt-note` 前缀）；前端全部用相对路径 |
| 写成节点 | 前端插入的图片必须落成思源原生形态：`NodeImage{Data:"span",Properties:{parent-style,style}}` + `NodeLinkDest{Data:"assets/<name>"}`，`alt` = 原文件名去扩展名 |
| 排版保真 | `parent-style: width:25%` 决定一行几张（连续同宽图片段落包进 `div.img-rows`），`style: width:10000px` 是原图宽度（靠 `max-width:100%` 收进容器） |
| 导入 | `assets/*` 按原名导入；仅同名冲突时改名，并同步改写文档/超链接里的 `assets/<原名>` 引用 |

## 导入 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `api/import/upload` | multipart `file`(zip)；自动识别：含 `*.sy` → 思源格式；含 `*.md` → markdown 格式 |
| POST | `api/import/path` | `{path:"D:/... 或 /vol1/..."}` 服务器本地目录（同样自动识别） |
| GET | `api/export/siyuan?box=<id|all>` | 下载 zip：`data/<box>/<doc>.sy` + `data/assets/*`（可直接解到思源工作区） |
| GET | `api/export/md?box=<id|all>` | 下载 zip：`<笔记本>/<标题>.md` + `assets/*` |

导入识别细节：
- **思源格式**：zip 内 `<boxID>/<docID>.sy`（可带一层 `data/` 前缀），`.siyuan/conf.json` → 笔记本名；`assets/*` → `data/assets/`（**按原名**，同名冲突才改名并改写文档内引用，否则 `.sy` 里的图片会 404）。
- **markdown 格式**：`<笔记本名>/<标题>.md` + `assets/*`（即思源「导出 Markdown」包的结构），逐个转 .sy。
- 单文件 `.md`（如「全部笔记汇总.md」）→ 建一个同名笔记本，按一级标题拆成多篇文档。

## 会话与 PIN

未解锁时，所有数据接口（`api/tree`、`api/doc`、`api/search`、`assets/*`、导入导出）一律 `401`
——标题、正文、图片都不下发；只有 `api/health`、`api/session` 与 `api/pin/*` 可用。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/session` | `{version,prefix,user:{uid,name,isAdmin,local},needsSetup,locked,hasLibrary,stats?,sessions?,sessionExpiresAt?}`；前端据此决定先显示「设 PIN」屏、「解锁」屏还是主界面；解锁后额外给 `sessions`（该账号当前有效会话数，含本机）与 `sessionExpiresAt`（本机这枚令牌的到期时间，RFC3339/UTC）。未解锁时额外给 `reason`（`no_token` / `token_invalid` / `identity_changed`）与 `tokenUid`（原因同上时的原 uid）——用来区分「密码输错了」和「凭证根本没留下来」 |
| POST | `api/pin/setup` | `{pin:"6 位数字"}` → `{ok,onboarded,weak,token}`，同时下发会话 Cookie；仅在该用户从未设过 PIN 时可用 |
| POST | `api/pin/unlock` | `{pin}` → `{ok,weak,token}`；错码 → 401，响应里带剩余次数 |
| POST | `api/pin/lock` | `{}` → `{ok,locked:true}`（已解锁时用）；本机这枚令牌与 Cookie 同时作废 |
| POST | `api/pin/change` | `{old,new}` → `{ok,weak,token}`；`weak:true` 指新 PIN 命中弱口令表（仍可设置，前端只给提示）。改完该账号的**其它会话全部作废**，本机换一枚新令牌继续用 |
| POST | `api/pin/revoke` | `{}` → `{ok,revoked:n,sessions:1,token}`；作废该账号其它设备上的解锁（`revoked` 不含本机），本机换新令牌。「手机丢了」用这个 |

会话：`ztnote_session` Cookie（HttpOnly、SameSite=Lax、Path=`<prefix>/`、30 天），值是服务端随机令牌，
绑定 uid——同一个浏览器换了网关注入的 uid，令牌也不认。

令牌共四个通道，服务端按顺序取第一个认得的（同一个令牌换个通道也一样认）：

| 顺序 | 通道 | 用在哪 |
|---|---|---|
| 1 | `Authorization: Bearer <token>` | 非浏览器客户端（脚本、TV 端、自建客户端） |
| 2 | `X-Zt-Token: <token>` | 前端所有 fetch/XHR。飞牛 App 的 WebView 会把 Cookie 当第三方拦掉，这是主通道 |
| 3 | `?token=` / `?t=` | **只读请求**（GET/HEAD）：`<img src>`、导出下载这类发不了请求头的场景。写接口不认 URL 里的令牌 |
| 4 | Cookie | 普通浏览器，令牌不落到 JS 能读的地方 |

`pin/setup`、`pin/unlock`、`pin/change`、`pin/revoke` 的响应体里都会带一枚 `token`（与 Cookie 同值），
给「Cookie 存不下」的客户端（飞牛 App 的 WebView）存到 `localStorage`，之后用 `X-Zt-Token` 带回来。
只靠 Cookie 时，这类 WebView 的表现就是「PIN 输对了却一直让重输」：解锁成功但下一个请求又是未解锁。

PIN 存储：`users/<uid>/pin.json`——PBKDF2-HMAC-SHA256（12 万次迭代）+ 每用户随机盐，只存 salt 与 hash；
连续输错逐级锁定（第 5 次起 1 分钟、第 10 次起 5 分钟、第 15 次起 15 分钟，按 uid 计数）。PIN 是「防旁人随手翻看」的门，不是加密：磁盘上仍是明文 `.sy`
（要抗物理访问得靠卷加密）。

**忘了 PIN**：删掉 `users/<uid>/pin.json`（笔记与图片都在 `workspace/`，不受影响），刷新即可重设。
飞牛上该目录属应用用户，用「文件管理器」或以管理员身份处理。

**闲置自动锁定**是前端行为（时长存在浏览器 `localStorage.zt.autolock.minutes`，默认 30 分钟，可选
15/30/60/180 分钟或「永不」）：到点前端调 `api/pin/lock` 丢掉会话、回到 PIN 屏。服务端另外有一道
30 天不活动的兜底（见上）。

首次解锁（`setup`）时自动建《我的笔记》与一篇欢迎文档。

## 鉴权

`X-Trim-Userid` / `X-Trim-Username` / `X-Trim-Isadmin` 由统一网关注入，应用按 `uid` 隔离：
每个账号一份独立工作区 `$TRIM_PKGVAR/users/<uid>/workspace`（`internal/users`）；缺该头
（本机直连、开发）时回落为 `local` 用户。入口 `allUsers:true`，所以不再用管理员头做权限判断
——隔离靠 uid，防旁人靠 PIN。
