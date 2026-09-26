// 图片节点扩展：思源把图片的排版信息放在节点 Properties 里，
// parent-style 决定“一行挤几张”（width: 25%），style 决定缩放尺寸（width: 10000px 表示原始尺寸）。
// 声明成额外属性后，改图片所在的块也不会把它们丢掉（保存时后端写回 .sy）。
// 用 data-* 落地，避开与 HTML 原生 style 属性重名。
//
// 单独一个模块是为了让 ui/scripts/logic-test.ts 也能用同一份 schema 跑回归。
import Image from '@tiptap/extension-image'

export const ImageWithLayout = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      parentStyle: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-parent-style'),
        renderHTML: (attrs) =>
          attrs.parentStyle ? { 'data-parent-style': attrs.parentStyle } : {},
      },
      style: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-style'),
        renderHTML: (attrs) => (attrs.style ? { 'data-style': attrs.style } : {}),
      },
    }
  },
})
