// 首页 / 空态
import { store } from '../store'
import { clear, h } from '../dom'
import type { ViewHandle } from './doc'

export function mountHome(
  main: HTMLElement,
  actions: { newNotebook: () => void; newDoc: () => void; goImport: () => void },
): ViewHandle {
  const root = h('div', { class: 'page home-page' })
  clear(main)
  main.appendChild(root)

  const dataDir = store.health?.dataDir ?? ''
  root.appendChild(
    h(
      'div',
      { class: 'home-hero' },
      h('h1', { class: 'home-title' }, 'zt-note'),
      h(
        'p',
        { class: 'home-sub' },
        '在飞牛 NAS 上管理思源格式笔记：左侧选文档，顶部可新建 / 导入 / 导出。',
      ),
      h(
        'div',
        { class: 'home-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: actions.newDoc }, '新建文档'),
        h('button', { class: 'btn', type: 'button', onclick: actions.newNotebook }, '新建笔记本'),
        h('button', { class: 'btn', type: 'button', onclick: actions.goImport }, '导入笔记'),
      ),
      dataDir ? h('div', { class: 'home-note muted' }, `数据目录：${dataDir}`) : null,
      h(
        'div',
        { class: 'home-note muted' },
        '开发提示：本页所有请求走相对路径（api/…、assets/…），可直接挂在 fnOS 网关 /app/zt-note/ 下。',
      ),
    ),
  )
  if (!store.tree?.notebooks?.length) {
    root.appendChild(
      h(
        'div',
        { class: 'home-banner' },
        '还没有笔记本：点「新建笔记本」，或到「导入笔记」把现有思源 data 目录 / markdown-export zip 导进来。',
      ),
    )
  }
  return {
    destroy: () => {
      root.remove()
    },
  }
}
