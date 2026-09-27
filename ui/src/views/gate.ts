// PIN 门：应用启动时先看会话状态，没设 PIN 就引导设置，设了就要求解锁。
//
// 这一屏刻意不请求任何笔记数据：未解锁时后端也不会下发标题、搜索和图片。
import { api, setGateBusy } from '../api'
import { h, showModal, toast } from '../dom'
import type { PinResp, SessionResp } from '../types'

const PIN_LEN = 6

/* ---------------- 6 位 PIN 输入框 ---------------- */

export interface PinField {
  el: HTMLElement
  value: () => string
  clear: () => void
  focus: () => void
}

/**
 * 6 个圆点 + 一个透明输入框：点哪儿都能唤起键盘，输满 6 位就触发 onComplete。
 * 手机上用 inputmode=numeric，桌面键盘也能直接敲数字。
 */
export function pinField(
  label: string,
  opts: { autocomplete?: string; onComplete?: (value: string) => void; onInput?: () => void } = {},
): PinField {
  const slots: HTMLElement[] = []
  const slotRow = h(
    'div',
    { class: 'pin-slots' },
    ...Array.from({ length: PIN_LEN }, (_, i) => {
      const slot = h('span', { class: 'pin-slot' })
      slot.dataset.index = String(i)
      slots.push(slot)
      return slot
    }),
  )
  const input = h('input', {
    class: 'pin-input',
    type: 'tel',
    inputmode: 'numeric',
    maxlength: String(PIN_LEN),
    autocomplete: opts.autocomplete ?? 'off',
    'aria-label': label,
    spellcheck: 'false',
  }) as HTMLInputElement

  const render = (): void => {
    for (let i = 0; i < slots.length; i++) {
      slots[i].textContent = i < input.value.length ? '●' : ''
      slots[i].classList.toggle('is-filled', i < input.value.length)
      slots[i].classList.toggle('is-cursor', i === input.value.length)
    }
    slotRow.classList.toggle('is-error', false)
  }

  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D+/g, '').slice(0, PIN_LEN)
    if (clean !== input.value) input.value = clean
    render()
    opts.onInput?.()
    if (clean.length === PIN_LEN) opts.onComplete?.(clean)
  })
  // 点击圆点区域时把焦点交给输入框（透明输入框已覆盖整行，这里只是双保险）
  slotRow.addEventListener('click', () => input.focus())
  render()

  const el = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h('div', { class: 'pin-box' }, slotRow, input),
  )
  return {
    el,
    value: () => input.value,
    clear: () => {
      input.value = ''
      render()
    },
    focus: () => input.focus(),
  }
}

/* ---------------- 解锁 / 设置 PIN ---------------- */

export interface GateOptions {
  session: SessionResp
  /** 解锁成功（或首次设置成功）后回调，由 app 层去挂载主界面 */
  onUnlocked: (resp: PinResp) => void
}

export function createGate(opts: GateOptions): HTMLElement {
  const { session } = opts
  const setup = session.needsSetup

  /* ---- 顶部品牌与身份 ---- */
  const brand = h(
    'div',
    { class: 'gate-brand' },
    h('span', { class: 'brand-mark' }, 'Zt'),
    h(
      'div',
      {},
      h('div', { class: 'gate-title' }, '云记笔记'),
      h('div', { class: 'gate-sub' }, '飞牛 NAS · 思源笔记格式'),
    ),
  )
  const who = h(
    'div',
    { class: 'gate-who' },
    h('span', { class: 'gate-who-icon' }, '👤'),
    h('span', { class: 'gate-who-name' }, session.user.name),
    session.user.isAdmin ? h('span', { class: 'who-badge' }, '管理员') : null,
    session.user.local ? h('span', { class: 'who-badge is-muted' }, '本地') : null,
    h('span', { class: 'gate-who-uid' }, `uid ${session.user.uid}`),
  )

  /* ---- 正文：设置两遍 / 解锁一遍 ---- */
  const msg = h('div', { class: 'gate-msg', role: 'status', 'aria-live': 'polite' })
  const lead = h(
    'p',
    { class: 'gate-lead' },
    setup ? '这个账号还没有 PIN。设一个 6 位数字，之后每次打开都要输它。' : '输入 6 位 PIN 解锁你的笔记。',
  )
  if (setup && !session.hasLibrary) {
    lead.textContent += '（第一次进入会给你建一个空白笔记本和一篇使用说明）'
  }

  const buttons: HTMLButtonElement[] = []
  const setBusy = (busy: boolean): void => {
    for (const b of buttons) b.disabled = busy
    card.classList.toggle('is-busy', busy)
  }
  const showError = (text: string): void => {
    msg.textContent = text
    msg.classList.add('is-error')
    card.classList.remove('is-shake')
    void card.offsetWidth // 重新触发动画
    card.classList.add('is-shake')
  }
  const showInfo = (text: string): void => {
    msg.textContent = text
    msg.classList.remove('is-error')
  }

  const card = h('div', { class: 'gate-card' }, brand, who, lead)

  const finish = (resp: PinResp): void => {
    setBusy(false)
    if (resp.weak) toast('这个 PIN 太好猜了（比如 123456），建议解锁后改一个', 'error', 6000)
    setGateBusy(true)
    opts.onUnlocked(resp)
  }

  const fail = (err: unknown): void => {
    setBusy(false)
    showError(err instanceof Error ? err.message : '操作失败，请重试')
  }

  if (setup) {
    const first = pinField('PIN（6 位数字）')
    const again = pinField('再输一次')
    const btn = h('button', { class: 'btn primary gate-submit', type: 'button' }, '设置并进入')
    buttons.push(btn)
    const check = (): void => {
      const a = first.value()
      const b = again.value()
      btn.disabled = a.length < PIN_LEN || b.length < PIN_LEN || a !== b
      if (b.length === PIN_LEN && a !== b) showError('两次输入不一致')
      else if (msg.classList.contains('is-error')) showInfo('')
    }
    first.el.addEventListener('input', check)
    again.el.addEventListener('input', check)
    first.el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') again.focus()
    })
    again.el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void submit()
    })
    const submit = async (): Promise<void> => {
      if (btn.disabled) return
      setBusy(true)
      showInfo('正在设置…')
      try {
        finish(await api.pinSetup(first.value()))
      } catch (err) {
        fail(err)
        first.clear()
        again.clear()
        first.focus()
      }
    }
    btn.addEventListener('click', () => void submit())
    card.append(
      first.el,
      again.el,
      h('div', { class: 'gate-actions' }, btn),
      msg,
      h(
        'details',
        { class: 'gate-help' },
        h('summary', {}, 'PIN 能找回吗？'),
        h(
          'p',
          {},
          '不能。服务端只存哈希，连管理员也看不到你的 PIN。忘了的话，在 NAS 上删掉这个文件即可重新设置：',
        ),
        h('code', {}, `users/${session.user.uid}/pin.json`),
      ),
      h('div', { class: 'gate-foot' }, h('span', {}, `版本 ${session.version}`)),
    )
    // 自动聚焦，键盘直接可以敲
    window.setTimeout(() => first.focus(), 30)
    check()
    return h('div', { class: 'gate' }, card)
  }

  /* ---- 解锁 ---- */
  const field = pinField('PIN', {
    onComplete: () => void submit(),
  })
  const btn = h('button', { class: 'btn primary gate-submit', type: 'button' }, '解锁')
  buttons.push(btn)

  async function submit(): Promise<void> {
    if (btn.disabled) return
    const pin = field.value()
    if (pin.length < PIN_LEN) {
      showError('请输入 6 位数字')
      return
    }
    setBusy(true)
    showInfo('正在解锁…')
    try {
      finish(await api.pinUnlock(pin))
    } catch (err) {
      fail(err)
      field.clear()
      field.focus()
    }
  }

  btn.addEventListener('click', () => void submit())
  field.el.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void submit()
  })

  card.append(
    field.el,
    h('div', { class: 'gate-actions' }, btn),
    msg,
    h(
      'details',
      { class: 'gate-help' },
      h('summary', {}, '忘记 PIN 了？'),
      h(
        'p',
        {},
        '在 NAS 上删掉下面这个文件，刷新本页后可以重新设置（笔记数据不受影响）：',
      ),
      h('code', {}, `users/${session.user.uid}/pin.json`),
      h(
        'p',
        {},
        '连续输错会被逐级锁定（约 5 次后锁 1 分钟、10 次后 5 分钟、15 次后 15 分钟），稍等再试即可。',
      ),
    ),
    h(
      'div',
      { class: 'gate-foot' },
      h('span', {}, `版本 ${session.version}`),
      h('span', { class: 'gate-dot' }, '·'),
      h('span', {}, session.user.isAdmin ? '每个 NAS 账号的数据互相独立' : '只有你能看到自己的笔记'),
    ),
  )
  window.setTimeout(() => field.focus(), 30)
  return h('div', { class: 'gate' }, card)
}

/* ---------------- 修改 PIN（工具条里调用） ---------------- */

export async function openPinChangeDialog(): Promise<boolean> {
  const oldField = pinField('原 PIN', { autocomplete: 'current-password' })
  const newField = pinField('新 PIN（6 位数字）', { autocomplete: 'new-password' })
  const againField = pinField('再输一次新 PIN', { autocomplete: 'new-password' })
  const body = h('div', {}, oldField.el, newField.el, againField.el)
  const res = await showModal({
    title: '修改 PIN',
    message: '改完之后，其它设备上的登录会失效，需要重新解锁。',
    body,
    buttons: [
      { label: '取消', value: '' },
      { label: '保存', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      if (oldField.value().length < PIN_LEN) {
        toast('请输入原 PIN', 'error')
        return null
      }
      if (newField.value().length < PIN_LEN) {
        toast('新 PIN 需要 6 位数字', 'error')
        return null
      }
      if (newField.value() !== againField.value()) {
        toast('两次输入的新 PIN 不一致', 'error')
        return null
      }
      return 'ok'
    },
  })
  if (res !== 'ok') return false
  try {
    const resp = await api.pinChange(oldField.value(), newField.value())
    if (resp.weak) toast('PIN 已更新，但这个 PIN 太好猜了，建议再改一个', 'error', 6000)
    else toast('PIN 已更新', 'ok')
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : '修改 PIN 失败', 'error', 5000)
    return false
  }
}
