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
| POST | `api/doc/save` | `{box,id,blocks:[{id,pm,changed:bool,type}]}` |
| POST | `api/doc/create` | `{box,title,parentId?}` → `{id}` |
| POST | `api/doc/rename` | `{box,id,title}` |
| POST | `api/doc/delete` | `{box,id}` |
| POST | `api/notebook/create` | `{name}` → `{id}` |
| POST | `api/assets/upload` | multipart `file` → `{name,url}` |
保存语义：`changed:false` 的块按 `id` 复用原始 .sy 节点；`changed:true` 的块按 `pm` 重新生成
（保留块 ID）；`blocks` 中缺失的块视为删除；顺序以 `blocks` 数组为准。后端刷新 `updated`。

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
- **markdown 格式**：`<笔记本名>/<标题>.md` + `assets/*`（即 示例工作区/markdown-export 的结构），逐个转 .sy。
- 单文件 `.md`（如「全部笔记汇总.md」）→ 建一个同名笔记本，按一级标题拆成多篇文档。

## 会话与 PIN

未解锁时，所有数据接口（`api/tree`、`api/doc`、`api/search`、`assets/*`、导入导出）一律 `401`
——标题、正文、图片都不下发；只有 `api/health`、`api/session` 与 `api/pin/*` 可用。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/session` | `{version,prefix,user:{uid,name,isAdmin,local},needsSetup,locked,hasLibrary,stats?}`；前端据此决定先显示「设 PIN」屏、「解锁」屏还是主界面 |
| POST | `api/pin/setup` | `{pin:"6 位数字"}` → `{ok,onboarded,weak}`，同时下发会话 Cookie；仅在该用户从未设过 PIN 时可用 |
| POST | `api/pin/unlock` | `{pin}` → `{ok,weak}`；错码 → 401，响应里带剩余次数 |
| POST | `api/pin/lock` | `{}` → `{ok,locked:true}`（已解锁时用） |
| POST | `api/pin/change` | `{old,new}` → `{ok,weak}`；`weak:true` 指新 PIN 命中弱口令表（仍可设置，前端只给提示） |

会话：`ztnote_session` Cookie（HttpOnly、SameSite=Lax、Path=`<prefix>/`、30 天），值是服务端随机令牌，
绑定 uid——同一个浏览器换了网关注入的 uid，令牌也不认。

PIN 存储：`users/<uid>/pin.json`——PBKDF2-HMAC-SHA256（10 万次迭代）+ 每用户随机盐，只存 salt 与 hash；
连续错 5 次锁 30 秒（按 uid 计数）。PIN 是「防旁人随手翻看」的门，不是加密：磁盘上仍是明文 `.sy`
（要抗物理访问得靠卷加密）。

首次解锁（`setup`）时自动建《我的笔记》与一篇欢迎文档。

## 鉴权

`X-Trim-Userid` / `X-Trim-Username` / `X-Trim-Isadmin` 由统一网关注入，应用按 `uid` 隔离：
每个账号一份独立工作区 `$TRIM_PKGVAR/users/<uid>/workspace`（`internal/users`）；缺该头
（本机直连、开发）时回落为 `local` 用户。入口 `allUsers:true`，所以不再用管理员头做权限判断
——隔离靠 uid，防旁人靠 PIN。
