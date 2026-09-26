#!/usr/bin/env node
// 构建自检：确认 dist/index.html 存在，且引用的 js/css 都是相对路径（./static/...）。
// 用法：npm run build（postbuild 自动执行）或 npm run verify
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// scripts/ → ui/ → 仓库根，产物在 <仓库根>/internal/webui/dist
const dist = resolve(here, '..', '..', 'internal', 'webui', 'dist')
const problems = []
const ok = (msg) => console.log(`  ✓ ${msg}`)
const bad = (msg) => {
  problems.push(msg)
  console.log(`  ✗ ${msg}`)
}

console.log('zt-note 构建自检')
console.log(`产物目录：${dist}`)

if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  bad('产物目录不存在')
  console.log('\n自检失败：后端目录 internal/webui/dist 未生成')
  process.exit(1)
}
ok('产物目录存在')

const indexPath = join(dist, 'index.html')
if (!existsSync(indexPath)) {
  bad('index.html 不存在')
} else {
  ok('index.html 存在')
  const html = readFileSync(indexPath, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1])
  const assets = refs.filter((ref) => /\.(js|css)$/i.test(ref))
  if (!assets.length) bad('index.html 没有引用任何 js/css')

  for (const ref of assets) {
    if (ref.startsWith('./') || ref.startsWith('../')) {
      ok(`引用是相对路径：${ref}`)
    } else {
      bad(`引用不是相对路径：${ref}（必须形如 ./static/xxx）`)
    }
    const file = join(dist, ref.replace(/^\.\//, ''))
    if (existsSync(file)) ok(`引用的文件存在：${ref.replace(/^\.\//, '')}`)
    else bad(`引用的文件缺失：${ref}`)
  }

  const absolute = refs.filter((ref) => ref.startsWith('/') && !ref.startsWith('//'))
  if (absolute.length) bad(`index.html 含绝对路径引用：${absolute.join(', ')}（网关前缀下会 404）`)
  else ok('index.html 无绝对路径引用')

  // 关键资源目录（vite 的 assetsDir，见 vite.config.ts：必须避开网关保留前缀 assets）
  if (existsSync(join(dist, 'static'))) ok('static/ 目录存在')
  else bad('static/ 目录缺失（assetsDir 应为 static，不能用网关保留的 assets）')
  if (existsSync(join(dist, 'assets'))) bad('产物里出现了 assets/ 目录：该前缀被 fnOS 网关占用，请检查 assetsDir 配置')
}

// 产物里不应出现指向站点根的绝对 URL（例如 url(/static/x.png)）
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

if (existsSync(dist)) {
  const files = walk(dist)
  ok(`产物体积：${files.length} 个文件 / ${(files.reduce((n, f) => n + statSync(f).size, 0) / 1024).toFixed(1)} KB`)
  for (const file of files.filter((f) => /\.(css|js)$/i.test(f))) {
    const text = readFileSync(file, 'utf8')
    const hits = [...text.matchAll(/url\(\s*['"]?\/[^'")]+/g)].map((m) => m[0])
    if (hits.length) bad(`${file.replace(dist, '.')} 含绝对资源 URL：${hits.slice(0, 3).join(', ')}`)
  }
  ok('未发现绝对资源 URL')
}

if (problems.length) {
  console.log(`\n自检失败：${problems.length} 项问题`)
  process.exit(1)
}
console.log('\n自检通过：产物可在 /app/zt-note/ 这类子路径下正常工作')
