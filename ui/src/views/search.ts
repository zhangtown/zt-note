// 搜索结果视图：#/search?q=xxx
import { api } from '../api'
import { notebookName } from '../store'
import { clear, emptyBox, errorBox, h, highlightText, spinner } from '../dom'
import { navigate } from '../router'
import type { SearchHit } from '../types'
import type { ViewHandle } from './doc'

export function mountSearch(main: HTMLElement, q: string): ViewHandle {
  let destroyed = false
  const root = h('div', { class: 'page' })
  clear(main)
  main.appendChild(root)

  if (!q.trim()) {
    root.appendChild(
      h(
        'div',
        { class: 'page-header' },
        h('h1', { class: 'page-title' }, '搜索'),
        h('div', { class: 'page-meta muted' }, '在上方搜索框输入关键词，回车开始搜索（标题 + 正文，忽略大小写）'),
      ),
    )
    root.appendChild(emptyBox('还没有关键词', '例如：开票、NAS、隧道'))
    return { destroy: () => { destroyed = true } }
  }

  root.appendChild(
    h(
      'div',
      { class: 'page-header' },
      h('h1', { class: 'page-title' }, `搜索：${q}`),
      h('div', { class: 'page-meta muted' }, '正在搜索…'),
    ),
  )
  const listWrap = h('div', { class: 'search-list' })
  root.appendChild(h('div', { class: 'quiet' }, spinner('搜索中…')))
  const loading = root.lastElementChild as HTMLElement

  api
    .search(q)
    .then((data) => {
      if (destroyed) return
      loading.remove()
      const hits = data.hits ?? []
      const meta = root.querySelector('.page-meta')
      if (meta) meta.textContent = `共 ${hits.length} 条结果`
      root.appendChild(listWrap)
      if (!hits.length) {
        listWrap.appendChild(emptyBox('没有找到匹配内容', '换个关键词试试，或确认后端已建立索引。'))
        return
      }
      hits.forEach((hit) => listWrap.appendChild(hitCard(hit, q)))
    })
    .catch((err: unknown) => {
      if (destroyed) return
      loading.remove()
      const meta = root.querySelector('.page-meta')
      if (meta) meta.textContent = ''
      root.appendChild(
        errorBox(err instanceof Error ? err.message : '搜索失败', () => {
          void mountSearch(main, q)
        }),
      )
    })

  return {
    destroy: () => {
      destroyed = true
      root.remove()
    },
  }
}

function hitCard(hit: SearchHit, q: string): HTMLElement {
  const target = q.trim()
  return h(
    'div',
    {
      class: 'search-hit',
      title: hit.blockId ? `定位到块 ${hit.blockId}` : '整篇命中，点击打开',
      onclick: () =>
        navigate({
          name: 'doc',
          box: hit.box,
          id: hit.id,
          mode: 'read',
          block: hit.blockId ?? '',
        }),
    },
    h(
      'div',
      { class: 'hit-top' },
      h('span', { class: 'hit-title', html: highlightText(hit.title || hit.id, target) }),
      h('span', { class: 'hit-box badge' }, notebookName(hit.box)),
    ),
    h('div', { class: 'hit-snippet', html: highlightText(hit.snippet ?? '', target) }),
  )
}
