# zt-note 前端（ui/）

飞牛 fnOS NAS 上的思源笔记类应用 —— 前端工程。Vite + TypeScript + TipTap，**不引 UI 框架**（样式手写在 `src/styles.css`）。
后端契约见 `../docs/API.md`，思源格式与块模型见 `../docs/SIYUAN-FORMAT.md`。

## 开发

```bash
npm install                 # 依赖装不动时：npm config set registry https://registry.npmmirror.com
npm run dev                 # http://127.0.0.1:5173
```

`npm run dev` **需要后端跑在 `http://127.0.0.1:8765`**（vite dev proxy 把 `/api` 与 `/assets` 代理过去；
后端地址可用环境变量覆盖：`ZTNOTE_API=http://127.0.0.1:9000 npm run dev`）。
后端未就绪时页面不会白屏：顶栏版本区会显示后端错误文案，文档树显示错误态并可点「重试」。

## 构建 / 自检

```bash
npm run build      # tsc --noEmit && vite build → ../internal/webui/dist（base: './'，emptyOutDir）
                   # postbuild 自动跑 scripts/check-build.mjs：校验产物存在、引用是相对路径
npm run test:logic # 块模型逻辑自测（真实 TipTap schema 跑 sanitize/planSave，21 项断言）
npm run smoke      # 无头 Chrome 冒烟：把 dist 挂到 /app/zt-note/ 前缀检查外壳与错误态
npm run check      # 以上三步依次执行
```

产物要求（网关挂载前提）：`base: './'`、`outDir: '../internal/webui/dist'`、`emptyOutDir: true`，
`dist/index.html` 里引用必须是 `./assets/...` 这类相对路径 —— 由 `scripts/check-build.mjs` 把关。

## 目录

```
ui/
├── index.html            # 挂载点（#app / #modal-root / #toast-root），布局由 app.ts 装配
├── vite.config.ts        # base './'、outDir ../internal/webui/dist、dev proxy /api + /assets
├── src/
│   ├── main.ts           # 入口：启动 + 启动失败的兜底错误页
│   ├── logo.ts           # 「云记笔记」标识（内联 SVG，与应用图标同款：深蓝方块 + 白页 + 蓝线）
│   ├── app.ts            # 布局装配（侧栏顶部「🏠 首页」、顶栏不放品牌）、路由分发、全局动作
│   ├── api.ts            # fetch 封装（统一 {ok:false,error} 解析 + 内置令牌） + 相对路径 api/* + 导出 URL
│   ├── router.ts         # hash 路由 #/ 、#/doc/<box>/<id>?mode=&block= 、#/search?q= 、#/import
│   ├── store.ts          # 极简状态：文档树、健康信息、当前选中项、树展开（localStorage）
│   ├── types.ts          # 与 API.md 对应的类型
│   ├── dom.ts            # h() DOM 工具 + 弹窗/确认/输入/轻提示/状态块
│   ├── docjson.ts        # 块模型：sanitizeBlocks（schema 对齐降级）、planSave（LCS 对齐 + changed 标记）
│   ├── editor.ts         # TipTap 编辑器（工具条、代码块语言、链接/图片弹窗、图片上传、正文右键菜单、块高亮装饰器）
│   ├── styles.css        # 手写样式（浅色、紧凑、中文字体栈；末尾一节是 ≤900px 窄屏规则）
│   └── views/
│       ├── tree.ts       # 左侧文档树（笔记本 → 文档，children 递归，展开状态持久化，右键菜单）
│       ├── menu.ts       # 通用右键/下拉菜单（.ctx-menu，笔记本与文档共用）
│       ├── topbar.ts     # 顶栏（不放品牌；新建/重命名/删除/导入/导出菜单/搜索框/后端版本）
│       ├── doc.ts        # 文档视图：只读文档走后端 html，其余打开即编辑（自动保存、状态行、标题就地改、搜索块高亮）
│       ├── search.ts     # 搜索结果列表（标题/片段高亮，点击跳文档）
│       ├── import.ts     # 导入向导（zip 上传 / 服务器目录）
│       └── home.ts       # 首页空态
└── scripts/
    ├── check-build.mjs   # 产物相对路径自检（build 后自动跑）
    ├── logic-test.ts     # 块模型逻辑自测（esbuild 打包后在 Node 跑）
    └── smoke.mjs         # 无头浏览器冒烟（静态服务 + CDP，无后端）
```

## 关键约定

- **品牌标识**：只此一处 `src/logo.ts`（`logoSvg` / `logoMark(size)` / `logoDataUri` / `applyFavicon`，配 `.logo-mark` 类），
  与应用图标 `tools/mkicon` 同款；favicon 是 `main.ts` 启动时注入的 data URI。
  顶栏与侧栏都不放品牌（首页 hero 已有），回首页靠侧栏顶部的「🏠 首页」行（`app.ts` 的 `.tree-nav-item`）。

- **打开即编辑 + 自动保存**：文档只说“编辑模式”（没有单独的“查看模式开关”），改动停下约 0.9s 写盘
  （`views/doc.ts` 的 `IDLE_MS` / `MIN_GAP_MS` / `MAX_DELAY_MS`），页头状态行显示已保存 / 保存中 / 失败；
  只读文档（后端标了 readonly）不挂编辑器，仍走后端渲染的 html。
- **块高亮用装饰器**：搜索定位到块时不要手改编辑器 DOM（ProseMirror 重绘会抹掉），
  走 `editor.ts` 的 `flashPlugin`（`DecorationSet`，`revealBlock()` dispatch 一个带 `ztnote-flash` meta 的 transaction）。

- **相对路径**：页面可能挂在 `/app/zt-note/` 下，所有请求写 `fetch('api/tree')`、图片写 `assets/xx.png`，
  绝不写 `/api/...`。路由用 hash，所以文档 URL 的目录部分不变，相对路径始终解析到网关前缀。
- **块模型**：进入编辑时把每个 block 的 `pm` 顺序拼成一个 ProseMirror doc；保存时按顶层节点生成
  `{id, pm, changed, type}`：深度相等 → `changed:false` 带原 `id`；同块有改动 → `changed:true` 保留原 `id`；
  新增 → `id:null`；删除的块不下发。编辑器 schema 不认识的块（例如表格）会降级为纯文本，
  只要用户没动它，保存时仍是 `changed:false` + 原块 ID，由后端复用原 `.sy` 节点。
- **代码块语言**：`codeBlock.attrs.language` 透传（选中代码块时工具条上的语言输入框可改）。
- **图片**：`Image.configure({ inline: true })`，与思源行内图片块兼容；插入图片支持填相对 `assets/...` 路径
  或上传（`POST api/assets/upload`）。
- **导出**：`window.location = 'api/export/siyuan?box=<id|all>'`（或 `md`）直接触发下载。

## 依赖

运行时：`@tiptap/core`、`@tiptap/starter-kit`、`@tiptap/extension-link`、`@tiptap/extension-image`、
`@tiptap/extension-placeholder`（版本 2.27.3）。
开发期：`vite`、`typescript`（`esbuild` 由 vite 带入，仅自测脚本用）。
未引入任何 UI 框架、状态库、HTTP 库；表格等额外扩展也未引入（表格块走「降级 + 原样保留」路线）。
