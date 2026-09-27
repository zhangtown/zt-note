// 入口：装配应用。所有请求都用相对路径，因而可挂在任意前缀（如 /app/zt-note/）下。
import './styles.css'
import { bootstrap } from './app'
import { applyFavicon } from './logo'

function start(): void {
  // 标签页图标就是云栖笔记标识（与页面内的 logo 同源）
  applyFavicon()
  try {
    bootstrap()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const app = document.getElementById('app')
    if (app) {
      app.innerHTML = ''
      const box = document.createElement('div')
      box.className = 'error-box'
      box.style.margin = '24px auto'
      box.style.maxWidth = '560px'
      const title = document.createElement('div')
      title.className = 'error-title'
      title.textContent = '前端启动失败'
      const msg = document.createElement('div')
      msg.className = 'error-msg'
      msg.textContent = message
      box.append(title, msg)
      app.appendChild(box)
    }
    console.error('[zt-note] 启动失败：', err)
  }
}

// 未处理的 Promise 异常只在控制台留痕，避免静默失败。
window.addEventListener('unhandledrejection', (e) => {
  console.error('[zt-note] 未处理的请求异常：', e.reason)
})

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
