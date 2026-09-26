import { defineConfig } from 'vite'

// 开发时代理到本机后端（生产由 fnOS 网关挂在 /app/zt-note/ 下，走相对路径）。
// 不引入 @types/node，这里对 process 做最小声明（vite.config.ts 由 Node 执行）。
declare const process: { env?: { ZTNOTE_API?: string } }
const API_TARGET = process.env?.ZTNOTE_API ?? 'http://127.0.0.1:8765'

export default defineConfig({
  // 产物必须能被放在任意子路径下（/app/zt-note/），所以用相对 base。
  base: './',
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    target: 'es2020',
    // 不用 vite 默认的 assets/：该前缀被 fnOS 网关保留（网关会尝试解析 /app/<id>/assets/*），
    // 用 static/ 避免与网关的资源路由撞车。
    assetsDir: 'static',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // 开发时代理后端静态资源（图片等）
      '/static': { target: API_TARGET, changeOrigin: true },
    },
  },
})
