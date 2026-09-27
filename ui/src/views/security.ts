// PIN 与安全：一屏管完 PIN、闲置自动锁定、其它设备上的解锁，以及「忘记 PIN 怎么重置」。
import { api } from '../api'
import { confirmDialog, h, showModal, toast } from '../dom'
import {
  AUTOLOCK_CHOICES,
  autoLockLabel,
  readAutoLockMinutes,
  writeAutoLockMinutes,
} from '../autolock'
import { openPinChangeDialog } from './gate'
import { store } from '../store'
import type { SessionResp } from '../types'

export interface SecurityCtx {
  session: SessionResp
  /** 锁定：丢掉会话回 PIN 屏 */
  onLock: () => void
  /** 自动锁定时长变了（app 层据此让计时器立即采用新值） */
  onAutoLockChange: (minutes: number) => void
}

/** RFC3339 → 本地时间（后端给的是 UTC） */
function localTime(iso?: string): string {
  if (!iso) return '未知'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** PIN 文件路径：数据根目录 / users/<uid>/pin.json（拿不到根目录时给相对路径） */
export function pinFilePath(session: SessionResp, dataRoot?: string): string {
  const rel = `users/${session.user.uid}/pin.json`
  const root = (dataRoot ?? store.health?.dataRoot ?? '').replace(/[\\/]+$/, '')
  return root ? `${root}/${rel}` : rel
}

function row(label: string, value: Node | string, sub?: string): HTMLElement {
  return h(
    'div',
    { class: 'sec-row' },
    h('span', { class: 'sec-label' }, label),
    h('span', { class: 'sec-value' }, value, sub ? h('span', { class: 'sec-sub' }, sub) : null),
  )
}

async function copyText(text: string, input: HTMLInputElement): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      toast('路径已复制', 'ok', 2500)
      return
    }
  } catch {
    /* 非安全上下文（http）下 clipboard 可能不可用，退回下面的选中方案 */
  }
  input.focus()
  input.select()
  const done = (() => {
    try {
      return document.execCommand('copy')
    } catch {
      return false
    }
  })()
  if (done) toast('路径已复制', 'ok', 2500)
  else toast('已选中路径，按 Ctrl+C 复制', 'info', 4000)
}

/** 打开「PIN 与安全」面板。 */
export async function openSecurityDialog(ctx: SecurityCtx): Promise<void> {
  let session = ctx.session

  /* ---- 状态区（撤销 / 改 PIN 后会重新拉一次会话） ---- */
  const status = h('div', { class: 'sec-status' })

  const renderStatus = (): void => {
    const n = session.sessions ?? 1
    const isAdmin = session.user.isAdmin
    const rows: HTMLElement[] = [
      row(
        '身份',
        `${session.user.name}${isAdmin ? '（管理员）' : ''}`,
        `uid ${session.user.uid}${session.user.local ? ' · 本地访问' : ''}`,
      ),
      row(
        '本次解锁',
        session.sessionExpiresAt ? `${localTime(session.sessionExpiresAt)} 到期` : '有效期暂不可知',
        '30 天不活动会自动上锁（每次使用自动续期）',
      ),
      row(
        '已解锁设备',
        n > 1 ? `共 ${n} 处（含本机）` : '仅本机',
        n > 1 ? '其它设备可以在下面一键撤销' : '没有别的设备在解锁状态',
      ),
    ]
    if (session.dataDir) rows.push(row('数据目录', session.dataDir))
    const pinPath = pinFilePath(session)
    const pathInput = h('input', {
      class: 'input path-input',
      type: 'text',
      readonly: 'true',
      value: pinPath,
      'aria-label': 'PIN 文件路径',
    }) as HTMLInputElement
    const btnCopy = h(
      'button',
      { class: 'btn', type: 'button' },
      '复制路径',
    )
    btnCopy.addEventListener('click', () => void copyText(pinPath, pathInput))

    const resetBox = h(
      'details',
      { class: 'sec-help' },
      h('summary', {}, '忘记 PIN 了，怎么重置？'),
      h(
        'p',
        {},
        'PIN 只存哈希，找不回来；但笔记本身是明文，所以「重置」= 删掉锁文件，笔记一个字都不会动。',
      ),
      h('div', { class: 'path-row' }, pathInput, btnCopy),
      h(
        'ol',
        { class: 'sec-steps' },
        h('li', {}, '在 NAS 上删掉上面这个文件（飞牛「文件管理器」或 SSH，需要管理权限）'),
        h('li', {}, '回到本页刷新，会重新让你设置 PIN；解锁后文档、图片、表格都还在'),
      ),
      h(
        'p',
        { class: 'sec-hint' },
        '只想换一个 PIN 的话不用删文件：点上面的「修改 PIN」，输原 PIN 即可。',
      ),
    )

    status.replaceChildren(
      ...rows.concat(resetBox),
    )
  }
  renderStatus()

  /* ---- 自动锁定 ---- */
  let minutes = readAutoLockMinutes()
  const select = h(
    'select',
    { class: 'input sec-select', 'aria-label': '闲置自动锁定' },
    ...AUTOLOCK_CHOICES.map((c) =>
      h('option', { value: String(c.minutes), selected: c.minutes === minutes ? 'true' : null }, c.label),
    ),
  ) as HTMLSelectElement
  select.addEventListener('change', () => {
    minutes = writeAutoLockMinutes(Number.parseInt(select.value, 10))
    ctx.onAutoLockChange(minutes)
    // 用 info 而不是 ok：ok 类提示被「保存成功」的测试断言占用，别互相抢
    toast(minutes > 0 ? `闲置 ${autoLockLabel(minutes)} 后自动上锁` : '已关闭自动锁定', 'info', 3000)
  })

  const autoBox = h(
    'div',
    { class: 'sec-block' },
    h('div', { class: 'sec-block-title' }, '闲置自动锁定'),
    h(
      'div',
      { class: 'sec-block-body' },
      h('span', { class: 'sec-inline-label' }, '闲置'),
      select,
      h('span', { class: 'sec-inline-label' }, '后自动上锁'),
    ),
    h(
      'p',
      { class: 'sec-hint' },
      '按设备保存（手机可以设短一些）。到点后本设备会丢掉会话，再打开需要重新输 PIN。',
    ),
  )

  /* ---- 动作区 ---- */
  const btnChange = h('button', { class: 'btn primary', type: 'button' }, '修改 PIN')
  btnChange.addEventListener('click', () => {
    void (async () => {
      const changed = await openPinChangeDialog()
      if (changed) {
        // 改 PIN 会作废其它设备上的会话，本机换了一枚新会话：状态区重新拉一次
        await refresh()
        toast('其它设备上的解锁已作废，本机保持解锁', 'info', 4500)
      }
    })()
  })

  const btnRevoke = h('button', { class: 'btn', type: 'button' }, '撤销其它设备')
  btnRevoke.addEventListener('click', () => void revoke())

  async function revoke(): Promise<void> {
    const others = Math.max(0, (session.sessions ?? 1) - 1)
    if (others === 0) {
      toast('没有其它设备在解锁状态', 'info', 3000)
      return
    }
    const yes = await confirmDialog(
      '撤销其它设备',
      `其它 ${others} 处解锁会立刻失效（需要重新输 PIN），本机保持解锁。继续？`,
      '撤销',
    )
    if (!yes) return
    try {
      const resp = await api.pinRevoke()
      const revoked = resp.revoked ?? 0
      await refresh()
      toast(
        revoked > 0 ? `已撤销 ${revoked} 处解锁` : '没有其它设备需要撤销',
        'info',
        3500,
      )
    } catch (err) {
      toast(err instanceof Error ? err.message : '撤销失败', 'error', 4500)
    }
  }

  async function refresh(): Promise<void> {
    try {
      session = await api.session()
    } catch {
      /* 拉不到就沿用旧数据，至少面板不空 */
    }
    renderStatus()
  }

  const body = h(
    'div',
    { class: 'sec' },
    status,
    autoBox,
    h(
      'div',
      { class: 'sec-block' },
      h('div', { class: 'sec-block-title' }, '操作'),
      h('div', { class: 'sec-actions' }, btnChange, btnRevoke),
    ),
  )

  const res = await showModal({
    title: 'PIN 与安全',
    message: 'PIN 是应用层的一道锁，磁盘上的 .sy 文件仍是明文 —— 别把它当加密用。',
    body,
    buttons: [
      { label: '关闭', value: '' },
      { label: '立即锁定', value: 'lock' },
    ],
  })
  if (res === 'lock') ctx.onLock()
  else {
    // 面板关闭后把活动时间刷新一下，避免刚看完设置就被判定闲置
    ctx.onAutoLockChange(minutes)
  }
}
