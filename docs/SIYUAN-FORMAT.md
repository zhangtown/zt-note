# 思源 .sy 格式笔记（zt-note 的数据契约）

zt-note 以**思源的 .sy JSON 为原生存储格式**，目标是：导入的笔记能 1:1 原样保存，
编辑后的内容能按同样格式回填（可直接丢回思源工作区 `data/` 目录）。

## 目录布局（与思源工作区一致）

```
<DATA_DIR>/data/
├── <boxID>/                      # 笔记本。目录名 = boxID（形如 20250604060237-hy6bj20）
│   ├── .siyuan/conf.json         # {"name": "笔记本名", ...}
│   ├── <docID>.sy                # 文档。文件名 = docID（形如 20250604140303-hqyymgg）
│   └── <父docID>/<子docID>.sy    # 子文档（文档树嵌套时）
└── assets/                       # 全局资源目录，正文里以 assets/xxx.png 引用
```

## 文档结构（本数据集实测，Spec "1"）

```json
{"ID":"<docID>","Spec":"1","Type":"NodeDocument",
 "Properties":{"custom-sy-readonly":"true","id":"<docID>","title":"开票信息","type":"doc","updated":"20250604141733"},
 "Children":[ <块节点...> ]}
```

- 顶层字段固定顺序：`ID`、`Spec`、`Type`、`Properties`、`Children`（序列化时保持一致，diff 干净）。
- `Properties.updated` = `yyyyMMddHHmmss`，保存时刷新；`Properties.title` = 文档标题。
- 块节点：

| Type | 关键字段 | 说明 |
|---|---|---|
| NodeParagraph | ID/Properties/Children | 段落 |
| NodeHeading | + `HeadingLevel`(1-6) | 标题 |
| NodeCodeBlock | `IsFencedCodeBlock` | 子节点见下 |
| NodeBlockquote | 子节点含 NodeBlockquoteMarker | 引用 |
| NodeList / NodeOrderedList | 子节点 NodeListItem | 列表 |
| NodeThematicBreak | — | 分隔线 |
| NodeTable / NodeTableRow / NodeTableCell | — | 表格（暂时只读渲染） |

- 代码块子节点：`NodeCodeBlockFenceOpenMarker{Data:"```"}` → `NodeCodeBlockFenceInfoMarker{CodeBlockInfo: base64(语言)}`
  → `NodeCodeBlockCode{Data: 源码}` → `NodeCodeBlockFenceCloseMarker{Data:"```"}`。
  `CodeBlockInfo` 为 base64（解出 `undefined` 视为空语言）。

- 行内节点（块的 Children）：

| Type | 字段 | 渲染 |
|---|---|---|
| NodeText | `Data` | 原样（注意 U+200B/200C/200D 零宽字符要清洗） |
| NodeSoftBreak | `Data:"\n"` | 换行 |
| NodeTextMark | `TextMarkType` / `TextMarkTextContent` / `TextMarkAHref` | 行内样式，见下表 |
| NodeImage | 子节点拼出 `![alt](src)`：NodeBang/NodeOpenBracket/NodeLinkText/NodeCloseBracket/NodeOpenParen/NodeLinkDest/NodeCloseParen | 图片 |
| NodeLink | 同上（无 NodeBang） | 链接 |
| NodeKramdownSpanIAL | `Data`（形如 `{: style="font-size: 24px;"}`） | 保留，不渲染 |
| NodeBackslash | `Data` | 输出 `\` |

- `TextMarkType` 取值（可空格分隔组合）：`strong` `em` `code` `a`(配 `TextMarkAHref`) `mark` `s` `u` `kbd` `sub` `sup` `tag` `inline-math`。
- 块节点必须有 `ID`（形如 `20250604060302-262z9vr`）与 `Properties.id`；行内节点的 `Properties.id` 为 `""`。
- 新 ID 生成：`yyyyMMddHHmmss` + `-` + 7 位小写字母数字随机。

## 渲染规则（.sy → HTML / Markdown）

与 `示例工作区/convert_siyuan_to_md.py` 一致（该脚本已实测跑通 12 篇笔记）：

- 段落 → `<p>`；标题 → `<h1..h6>`；引用 → `<blockquote>`；列表 → `<ul>/<ol><li>`；
  代码块 → `<pre><code class="language-x">`（HTML 转义）；图片 → `<img src="assets/...">`；
  链接 → `<a href>`；行内标记 → `<strong>/<em>/<code>/<a>/<mark>/<s>/<u>/<kbd>/<sub>/<sup>`。
- 图片地址保持 `assets/xxx`（前端页面 base 是 `/app/zt-note/`，相对路径可正确解析）。

## 编辑与回写策略（保真核心）

1. **未改动的块原样保留**：保存时后端按块 ID 复用原始 .sy 节点 JSON（NodeKramdownSpanIAL、
   NodeBackslash、图片的 markup 子节点等 quirks 全部零损失）。
2. **改动的块重新生成**：按原文档风格生成行内节点 —— 源文档用 `NodeTextMark` 兄弟节点风格
   （本数据集），就继续用该风格；新块沿用文档主流风格。
3. **块 ID 不变**：编辑只改块内容，不换 ID（思源的引用/锚点依赖它）。新增块生成新 ID。
4. `Properties` 整表保留，只刷新 `updated`。

## Markdown → .sy（导入 markdown-export 时用）

行级解析：`# 标题`、``` 代码围栏（含语言）、`> 引用`、`- ` / `1. ` 列表、`---` 分隔线、空行分段；
行内解析：`**粗**`、`*斜*`、`` `代码` ``、`[文本](url)`、`![alt](src)`、`~~删除~~`、`==高亮==`。
导出目录里的 `<!-- 最后更新: 2025... -->` 注释写入 `Properties.updated`。
