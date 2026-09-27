// 极简 DOM 工具 + 弹窗/提示（不引 UI 框架，全部手写）

type Props = Record<string, unknown>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') node.className = String(value)
      else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value as Partial<CSSStyleDeclaration>)
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value as Record<string, string>)
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
      } else if (key === 'html') {
        node.innerHTML = String(value)
      } else if (key === 'text') {
        node.textContent = String(value)
      } else {
        node.setAttribute(key, String(value))
      }
    }
  }
  append(node, children)
  return node
}

export function append(
  parent: Node,
  children: Array<Node | string | null | undefined | false>,
): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 只保留 <mark> 高亮 + 转义其余内容，供搜索结果片段使用。 */
export function highlightText(text: string, term: string): string {
  const escaped = escapeHtml(text)
  if (!term) return escaped
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return escaped.replace(new RegExp(safe, 'gi'), (m) => `<mark>${m}</mark>`)
  } catch {
    return escaped
  }
}

export function formatTime(raw?: string): string {
  if (!raw) return ''
  const s = String(raw)
  // 后端形如 20250604141733
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return s
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

export function spinner(label = '加载中…'): HTMLElement {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, label))
}

export function errorBox(message: string, onRetry?: () => void): HTMLElement {
  return h(
    'div',
    { class: 'error-box' },
    h('div', { class: 'error-title' }, '出错了'),
    h('div', { class: 'error-msg' }, message),
    onRetry ? h('button', { class: 'btn', onclick: onRetry }, '重试') : null,
  )
}

export function emptyBox(title: string, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'empty-box' },
    h('div', { class: 'empty-title' }, title),
    hint ? h('div', { class: 'empty-hint' }, hint) : null,
  )
}

/* ---------------- 弹窗 ---------------- */

export interface ModalButton {
  label: string
  value: string
  primary?: boolean
  /** 危险动作（删除类）：红色描边，且不参与回车提交 */
  danger?: boolean
}

interface ModalOptions {
  title: string
  message?: string
  body?: HTMLElement
  buttons: ModalButton[]
  /** 是否允许回车提交 */
  onSubmit?: () => string | null | undefined
}

let modalSeq = 0

export function showModal(opts: ModalOptions): Promise<string> {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root')
    if (!root) return resolve('')
    const id = `modal-${++modalSeq}`
    const close = (value: string) => {
      document.removeEventListener('keydown', onKey, true)
      mask.remove()
      resolve(value)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close('')
      } else if (e.key === 'Enter' && !e.isComposing) {
        const target = e.target as HTMLElement | null
        if (target && target.tagName === 'BUTTON') return
        if (opts.onSubmit) {
          e.preventDefault()
          const value = opts.onSubmit()
          if (value) close(value)
        } else {
          e.preventDefault()
          const primary = opts.buttons.find((b) => b.primary)
          if (primary) close(primary.value)
        }
      }
    }
    const mask = h(
      'div',
      { class: 'modal-mask', id, role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        {
          class: 'modal',
          onclick: (e: Event) => e.stopPropagation(),
        },
        h('div', { class: 'modal-title' }, opts.title),
        opts.message ? h('div', { class: 'modal-message' }, opts.message) : null,
        opts.body ?? null,
        h(
          'div',
          { class: 'modal-actions' },
          ...opts.buttons.map((b) =>
            h(
              'button',
              {
                class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
                onclick: () => close(b.value),
              },
              b.label,
            ),
          ),
        ),
      ),
    )
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) close('')
    })
    root.appendChild(mask)
    document.addEventListener('keydown', onKey, true)
    const focusTarget = mask.querySelector<HTMLElement>(
      'input, textarea, select, button.primary, button',
    )
    focusTarget?.focus()
  })
}

export async function confirmDialog(
  title: string,
  message: string,
  confirmLabel = '确定',
  danger = false,
): Promise<boolean> {
  const res = await showModal({
    title,
    message,
    buttons: [
      { label: '取消', value: '' },
      { label: confirmLabel, value: 'ok', danger, primary: !danger },
    ],
  })
  return res === 'ok'
}

/** 单行文本输入弹窗；返回 null 表示取消。 */
export async function promptDialog(
  title: string,
  label: string,
  initial = '',
  placeholder = '',
): Promise<string | null> {
  const input = h('input', {
    class: 'input',
    type: 'text',
    value: initial,
    placeholder,
    spellcheck: 'false',
  })
  const box = h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input)
  const res = await showModal({
    title,
    body: box,
    buttons: [
      { label: '取消', value: '' },
      { label: '确定', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      const v = input.value.trim()
      return v ? 'ok' : null
    },
  })
  return res === 'ok' ? input.value.trim() : null
}

/* ---------------- 轻提示 ---------------- */

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3200): void {
  const root = document.getElementById('toast-root')
  if (!root) return
  const node = h('div', { class: `toast toast-${kind}` }, message)
  root.appendChild(node)
  window.setTimeout(() => {
    node.classList.add('toast-out')
    window.setTimeout(() => node.remove(), 260)
  }, ms)
}
