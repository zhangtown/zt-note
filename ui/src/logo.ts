// 「云记笔记」标识：与 tools/mkicon 生成的应用图标同款
// ——深蓝渐变圆角方块 + 白色装订脊 + 白页 + 蓝色文字线。
//
// 手写 SVG，任意尺寸都清晰；PIN 门、启动错误屏、首页、侧栏、favicon 都从这里取，
// 避免每个地方各画一个「Zt」小方块导致风格不一致。
import { h } from './dom'

let seq = 0

/** SVG 文本；size 是像素边长（viewBox 固定 100×100）。 */
export function logoSvg(size: number): string {
  // 同页面可能出现多个 logo，渐变 id 必须各用各的，否则引用会互相串
  const gid = `zt-logo-grad-${++seq}`
  return [
    `<svg class="logo-svg" viewBox="0 0 100 100" width="${size}" height="${size}"`,
    ' aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">',
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#3374bf"/><stop offset="1" stop-color="#142a4c"/>',
    '</linearGradient></defs>',
    `<rect width="100" height="100" rx="22" fill="url(#${gid})"/>`,
    '<rect x="15" y="25.5" width="8.2" height="49" rx="4.1" fill="#fff" fill-opacity="0.4"/>',
    '<rect x="26.2" y="19.5" width="53.3" height="61" rx="5.5" fill="#fff" fill-opacity="0.95"/>',
    '<rect x="35.2" y="36" width="34.8" height="5" rx="2.5" fill="#2b5ca0"/>',
    '<rect x="35.2" y="48" width="34.8" height="5" rx="2.5" fill="#2b5ca0"/>',
    '<rect x="35.2" y="60" width="22" height="5" rx="2.5" fill="#2b5ca0"/>',
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

/** 把标签页图标换成云记笔记标识（浏览器打开时生效）。 */
export function applyFavicon(): void {
  document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove())
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = logoDataUri(64)
  document.head.appendChild(link)
}
