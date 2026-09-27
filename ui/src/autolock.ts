// 闲置自动锁定：多久没动就丢掉会话、回到 PIN 屏。
//
// 时长按浏览器（设备）保存：手机可以设短一点，桌面宽一些。
// 纯逻辑（normalize / shouldAutoLock / 标签）与 DOM 事件分离，方便被 npm run test:logic 覆盖。
export const AUTOLOCK_KEY = 'zt.autolock.minutes'

export interface AutoLockChoice {
  minutes: number
  label: string
}

/** 0 表示永不自动锁定；默认 30 分钟。 */
export const AUTOLOCK_CHOICES: AutoLockChoice[] = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 180, label: '3 小时' },
  { minutes: 0, label: '永不（不自动锁定）' },
]

export const DEFAULT_AUTOLOCK_MINUTES = 30

/** 把存储里的值规范成可选值之一：0 = 永不，非法值回落默认。 */
export function normalizeAutoLock(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOLOCK_MINUTES
  if (n === 0) return 0
  return AUTOLOCK_CHOICES.some((c) => c.minutes === n) ? n : DEFAULT_AUTOLOCK_MINUTES
}

/** 给人看的时长文案（也用于菜单里的一行提示）。 */
export function autoLockLabel(minutes: number): string {
  if (minutes <= 0) return '永不'
  const hit = AUTOLOCK_CHOICES.find((c) => c.minutes === minutes)
  if (hit) return hit.label
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

/** 只要能读写两个方法就够了（测试里传假的实现）。 */
export type AutoLockStore = Pick<Storage, 'getItem' | 'setItem'>

function safeStorage(): AutoLockStore | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // 隐私模式下访问 localStorage 会抛
  }
}

export function readAutoLockMinutes(store?: AutoLockStore): number {
  const s = store ?? safeStorage()
  if (!s) return DEFAULT_AUTOLOCK_MINUTES
  try {
    return normalizeAutoLock(s.getItem(AUTOLOCK_KEY))
  } catch {
    return DEFAULT_AUTOLOCK_MINUTES
  }
}

/** 写入设置并返回规范化后的值。 */
export function writeAutoLockMinutes(minutes: number, store?: AutoLockStore): number {
  const v = normalizeAutoLock(minutes)
  const s = store ?? safeStorage()
  try {
    s?.setItem(AUTOLOCK_KEY, String(v))
  } catch {
    /* 写不进去就算了：这次会话内仍然生效（调用方用返回值） */
  }
  return v
}

/** 纯函数：距上次活动是否已超过阈值（minutes<=0 表示永不锁）。 */
export function shouldAutoLock(lastActivity: number, now: number, minutes: number): boolean {
  if (minutes <= 0) return false
  if (!Number.isFinite(lastActivity)) return false
  return now - lastActivity >= minutes * 60_000
}

export interface AutoLockOptions {
  /** 读当前设置：每次检查都读，改了设置立即生效 */
  minutes: () => number
  /** 判定为闲置时调用（由 app 层负责真的去锁） */
  onLock: () => void
  /** 检查间隔，默认 30 秒 */
  intervalMs?: number
  now?: () => number
}

export interface AutoLockHandle {
  start(): void
  stop(): void
  /** 手动喂一次「有活动」 */
  touch(): void
  lastActivity(): number
  /** 立刻判定一次，返回是否触发了锁定 */
  check(): boolean
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'] as const

/** 监听活动（指针 / 键盘 / 触摸 / 输入），闲置超时就上锁。 */
export function createAutoLock(opts: AutoLockOptions): AutoLockHandle {
  const now = opts.now ?? (() => Date.now())
  const intervalMs = opts.intervalMs ?? 30_000
  let last = now()
  let timer: number | null = null
  let fired = false

  const touch = (): void => {
    last = now()
    fired = false
  }

  const check = (): boolean => {
    if (fired || timer === null) return false
    if (!shouldAutoLock(last, now(), opts.minutes())) return false
    fired = true
    stop()
    opts.onLock()
    return true
  }

  const onActivity = (): void => {
    if (!document.hidden) touch()
  }
  const onVisible = (): void => {
    if (document.hidden) return
    // 从后台回来：先判该不该锁，再刷新活动时间
    if (!check()) touch()
  }

  function start(): void {
    if (timer !== null) return
    touch()
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisible)
    timer = window.setInterval(check, intervalMs)
  }

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity)
    document.removeEventListener('visibilitychange', onVisible)
  }

  return { start, stop, touch, lastActivity: () => last, check }
}
