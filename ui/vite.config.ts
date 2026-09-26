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
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/assets': { target: API_TARGET, changeOrigin: true },
    },
  },
})
