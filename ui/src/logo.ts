// 「云栖笔记」标识：与 tools/mkicon 生成的应用图标同款（fnOS 风格）
// ——浅蓝渐变圆角底 + 磨砂玻璃文档 + 顶部一朵云，带柔和投影与极淡描边。
//
// 手写 SVG，任意尺寸都清晰；PIN 门、启动错误屏、首页、侧栏、favicon 都从这里取，
// 避免每个地方各画一个导致风格不一致。底色用浅蓝渐变（不是纯白），在白顶栏上也有轮廓。
import { h } from './dom'

let seq = 0

/** SVG 文本；size 是像素边长（viewBox 固定 256×256）。 */
export function logoSvg(size: number): string {
  // 同页面可能出现多个 logo，渐变 / 滤镜 id 必须各用各的，否则引用会互相串
  const g = `zt-logo-${++seq}`
  return [
    `<svg class="logo-svg" viewBox="0 0 256 256" width="${size}" height="${size}"`,
    ' aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">',
    '<defs>',
    `<linearGradient id="${g}-tile" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#eef5fd"/><stop offset="1" stop-color="#d3e4fb"/>',
    '</linearGradient>',
    `<radialGradient id="${g}-glow" cx="0.5" cy="0.42" r="0.7">`,
    '<stop offset="0" stop-color="#cfe4ff" stop-opacity="0.55"/>',
    '<stop offset="1" stop-color="#cfe4ff" stop-opacity="0"/>',
    '</radialGradient>',
    `<linearGradient id="${g}-doc" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#6aa6ff"/><stop offset="1" stop-color="#2f6fe0"/>',
    '</linearGradient>',
    `<linearGradient id="${g}-cloud" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d8ecff"/>',
    '</linearGradient>',
    `<filter id="${g}-blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>`,
    '</defs>',
    // 底板：浅蓝渐变圆角方块
    `<rect x="4" y="4" width="248" height="248" rx="58" fill="url(#${g}-tile)"/>`,
    // 内辉光
    `<ellipse cx="128" cy="118" rx="112" ry="96" fill="url(#${g}-glow)"/>`,
    // 文档柔影（向下偏移 + 高斯模糊）
    `<rect x="74" y="94" width="108" height="118" rx="18" fill="#274a86" opacity="0.30" filter="url(#${g}-blur)"/>`,
    // 云（白→浅蓝）
    `<g fill="url(#${g}-cloud)">`,
    '<ellipse cx="118" cy="80" rx="46" ry="26"/>',
    '<circle cx="90" cy="72" r="20"/><circle cx="120" cy="62" r="26"/><circle cx="150" cy="72" r="20"/>',
    '</g>',
    // 文档本体：亮蓝渐变
    `<rect x="74" y="86" width="108" height="118" rx="18" fill="url(#${g}-doc)"/>`,
    // 文档顶部高光
    '<rect x="74" y="86" width="108" height="58" rx="18" fill="#ffffff" opacity="0.18"/>',
    // 文字线（磨砂白，深浅不一）
    '<rect x="92" y="122" width="72" height="11" rx="5.5" fill="#ffffff" opacity="0.92"/>',
    '<rect x="92" y="146" width="58" height="11" rx="5.5" fill="#ffffff" opacity="0.70"/>',
    '<rect x="92" y="170" width="40" height="11" rx="5.5" fill="#ffffff" opacity="0.50"/>',
    // 左侧镜面高光
    '<rect x="80" y="92" width="14" height="40" rx="7" fill="#ffffff" opacity="0.35"/>',
    // 极淡描边（白底上勾出轮廓）
    `<rect x="4" y="4" width="248" height="248" rx="58" fill="none" stroke="#2b5fe0" stroke-opacity="0.10" stroke-width="2"/>`,
    '</svg>',
  ].join('')
}

/** 行内标识元素：默认 22px（顶栏 / 侧栏尺寸）。 */
export function logoMark(size = 22): HTMLElement {
  return h('span', { class: 'logo-mark', html: logoSvg(size) })
}

/** favicon 用的 data URI（挂到 <link rel="icon">）。 */
export function logoDataUri(size = 64): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(size))}`
}

/** 把标签页图标换成云栖笔记标识（浏览器打开时生效）。 */
export function applyFavicon(): void {
  document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove())
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = logoDataUri(64)
  document.head.appendChild(link)
}
