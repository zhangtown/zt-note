// 通用浮层菜单：侧栏文档树右键、正文右键都用它（手机上长按也能开）。
// 只做「显示 + 选中项回调」，具体动作由调用方给。
import { h } from '../dom'

export interface MenuItem {
  label?: string
  /** 行首图标（emoji 或短字符） */
  icon?: string
  /** 右侧快捷键提示（正文菜单用，如 Ctrl+B） */
  hint?: string
  /** 分隔线：只需要设置 separator: true，label 会被忽略 */
  separator?: boolean
  /** 危险操作（删除之类）标红 */
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}

let current: HTMLElement | null = null
let cleanup: (() => void) | null = null

/** 关掉当前菜单（没有也不报错）。 */
export function closeMenu(): void {
  if (cleanup) {
    cleanup()
    cleanup = null
  }
  if (current) {
    current.remove()
    current = null
  }
}

/** 当前是否有菜单展开。 */
export function menuOpen(): boolean {
  return current !== null
}

function build(items: MenuItem[]): HTMLElement {
  const el = h('div', { class: 'ctx-menu', role: 'menu' })
  for (const item of items) {
    if (item.separator) {
      el.appendChild(h('div', { class: 'ctx-menu-sep' }))
      continue
    }
    const btn = h(
      'button',
      {
        class: `ctx-menu-item${item.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled ? true : undefined,
      },
      h('span', { class: 'ctx-menu-icon' }, item.icon ?? ''),
      h('span', { class: 'ctx-menu-label' }, item.label ?? ''),
      item.hint ? h('span', { class: 'ctx-menu-hint' }, item.hint) : null,
    )
    btn.addEventListener('click', (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      if (item.disabled) return
      closeMenu()
      item.onClick?.()
    })
    el.appendChild(btn)
  }
  return el
}

/**
 * 在 (x, y) 处打开菜单：屏幕外会自动收边。
 * 返回是否真的打开了（全是分隔线时不开）。
 */
export function openMenu(x: number, y: number, items: MenuItem[]): boolean {
  closeMenu()
  const usable = items.filter((i) => i.separator || !i.disabled)
  if (!usable.some((i) => !i.separator)) return false

  const el = build(items)
  el.style.visibility = 'hidden'
  document.body.appendChild(el)
  const rect = el.getBoundingClientRect()
  const left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))
  const top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
  el.style.visibility = ''
  current = el

  const onPointerDown = (e: Event) => {
    if (current && e.target instanceof Node && current.contains(e.target)) return
    closeMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeMenu()
    }
  }
  const onReflow = () => closeMenu()
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onReflow)
  window.addEventListener('scroll', onReflow, true)
  el.querySelector<HTMLButtonElement>('.ctx-menu-item')?.focus()
  cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onReflow)
    window.removeEventListener('scroll', onReflow, true)
  }
  return true
}

/** 以某个元素的下沿为锚点开菜单（⋯ 按钮、正文里点中某处）。 */
export function openMenuAt(anchor: HTMLElement, items: MenuItem[], offsetY = 4): boolean {
  const rect = anchor.getBoundingClientRect()
  return openMenu(rect.left, rect.bottom + offsetY, items)
}

/**
 * 长按（触摸屏没有右键）：默认 500ms，按住后移动超过 10px 就算滑动、取消。
 * 触发过一次长按后，紧随其后的 click 会被吞掉（返回 true 值由调用方判断）。
 */
export function attachLongPress(el: HTMLElement, onLongPress: (x: number, y: number) => void): void {
  let timer: number | undefined
  let startX = 0
  let startY = 0
  let fired = false
  const cancel = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }
  el.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      fired = false
      cancel()
      timer = window.setTimeout(() => {
        timer = undefined
        fired = true
        if (window.navigator.vibrate) window.navigator.vibrate(10)
        onLongPress(startX, startY)
      }, 500)
    },
    { passive: true },
  )
  el.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel()
    },
    { passive: true },
  )
  el.addEventListener('touchend', cancel)
  el.addEventListener('touchcancel', cancel)
  // 长按已经弹了菜单，别让它再当成点击
  el.addEventListener(
    'click',
    (e: Event) => {
      if (fired) {
        fired = false
        e.stopPropagation()
        e.preventDefault()
      }
    },
    true,
  )
}
