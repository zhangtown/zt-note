# zt-note API 契约 v1

服务端：Go 单二进制，监听 Unix socket（`$TRIM_APPDEST/app.sock`）或开发时 TCP `127.0.0.1:8765`。
经 fnOS 统一网关访问时路径带前缀 `/app/zt-note`（服务端自动剥离）；开发直连无前缀。

前端一律使用**相对路径**（页面 URL 为 `/app/zt-note/` 或 `http://host:8765/`），
`fetch('api/tree')`、`<img src="assets/xx.png">` 均可正确解析。路由用 hash（`#/doc/<box>/<id>`）。

响应统一 `{"ok":true,...}` / 出错 `{"ok":false,"error":"..."}`（HTTP 4xx/5xx）。

## 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/health` | `{ok,version,dataDir,prefix}` |
| GET | `api/tree` | `{notebooks:[{id,name,icon,docs:[{id,title,updated,children:[...]}]}]}` |
| GET | `api/doc?box=<boxID>&id=<docID>` | `{id,box,title,updated,readonly,html,blocks:[{id,type,level?,pm}]}` |
| GET | `api/search?q=<词>&limit=50` | `{hits:[{box,id,title,blockId,snippet}]}`（标题+正文，忽略大小写） |
| GET | `assets/<文件>` | 图片等资源（来自 `data/assets/`） |

`blocks[].pm` 为该块的 ProseMirror 节点 JSON（TipTap 顶层节点），`type` 为对应的
`paragraph|heading|codeBlock|blockquote|bulletList|orderedList|image|thematicBreak|table`。

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

## 导入 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `api/import/upload` | multipart `file`(zip)；自动识别：含 `*.sy` → 思源格式；含 `*.md` → markdown 格式 |
| POST | `api/import/path` | `{path:"D:/... 或 /vol1/..."}` 服务器本地目录（同样自动识别） |
| GET | `api/export/siyuan?box=<id|all>` | 下载 zip：`data/<box>/<doc>.sy` + `data/assets/*`（可直接解到思源工作区） |
| GET | `api/export/md?box=<id|all>` | 下载 zip：`<笔记本>/<标题>.md` + `assets/*` |

导入识别细节：
- **思源格式**：zip 内 `<boxID>/<docID>.sy`（可带一层 `data/` 前缀），`.siyuan/conf.json` → 笔记本名；`assets/*` → `data/assets/`。
- **markdown 格式**：`<笔记本名>/<标题>.md` + `assets/*`（即 示例工作区/markdown-export 的结构），逐个转 .sy。
- 单文件 `.md`（如「全部笔记汇总.md」）→ 建一个同名笔记本，按一级标题拆成多篇文档。

## 鉴权

统一网关注入 `X-Trim-Userid` / `X-Trim-Isadmin` / `X-Trim-Username`。
应用入口 `allUsers:false`（仅管理员可见）；v1 不做应用内账号体系，写操作要求 `X-Trim-Isadmin: true`
（开发直连无该头时放行，便于本机调试）。
