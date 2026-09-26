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
| 7 | 接口级端到端 | `.test/e2e.py` 31/31 全绿（含"不改动直接保存 → 文件字节不变"） |
| 8 | UI 联调 | `ui/scripts/e2e-live.mjs`：真实后端 + 无头浏览器走完「点开→编辑→保存→磁盘核对」 |
| 9 | 打包 | `deploy/fnos-app/zt-note.fpk`（3.4 MB，fnpack 1.2.3，tar.gz），图标 Go 脚本生成 |

## 待办

- [ ] 部署到实机 NAS：装 fpk、导入那 12 篇真实笔记、逐篇点开核对渲染
- [ ] `internal/webui/dist` 与 Go 二进制的一致性检查（前端改动后忘记重建二进制是个真实坑）
- [ ] 图片上传的 UI（接口 `api/assets/upload` 已通，前端没接入）
- [ ] 块引用 / 块属性面板（`.sy` 里已保留原始字段，属于"读得懂写不回"）
- [ ] 表格编辑（当前只读渲染；思源表格属性不保留）
- [ ] 标签、书签、日记本等思源衍生块
- [ ] 多用户与权限（现在只区分管理员/非管理员，由网关决定）
- [ ] 定时/手动备份工作区（或写进 fpk 的 lifecycle 脚本）
- [ ] 移动端适配

## 决策记录

- **Web 应用而非 Tauri**：fnpack 原样打包 `app/`，Tauri 需自带 bundle 布局，塞进去 ~80 MB 且脆；
  Web 版 8 MB 单二进制，网关模式免端口/免 TLS。代价：无托盘、无本地文件唤起
- **`.sy` 为唯一存储格式**：不发明中间格式，保证随时能回到思源
- **保真靠"原样复用"而不是"完善反序列化"**：未编辑块直接 `json.RawMessage` 回写，
  避免穷举思源字段（这是唯一能真正做到逐字节一致的路子）
- **图标用 Go 生成**（`tools/mkicon`）：不引入 Node/ImageMagick 依赖，4x 超采样抗锯齿
- **鉴权交给网关**：应用内不做账号体系，`allUsers:false` + `X-Trim-Isadmin`
