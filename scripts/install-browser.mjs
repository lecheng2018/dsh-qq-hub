// 装浏览器 + 虚拟显示（不需要 root）。
//   node scripts/install-browser.mjs [--root <目录>] [--browser chrome|chromium|auto] [--no-smoke]
//
// 装到插件数据目录，只给插件的浏览器子进程用，不动系统。重复跑是安全的（装好了会跳过）。

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { installBrowser, verifyInstalled, installedInfo } from '../src/browser/install.js'
import { dataDir } from '../src/core/store.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.log('⚠️ ', ...a),
  debug: () => {},
}

const root = arg('--root', dataDir('browser'))
const browser = arg('--browser', 'auto')
const smoke = !has('--no-smoke')

console.log(`安装目录：${root}`)
const done = verifyInstalled(root)
if (done.ok) {
  const info = installedInfo(root)
  console.log(`已经装好了：${info.browser}`)
  console.log(`种类：${info.kind}　占用：${Math.round((info.sizeBytes || 0) / 1048576)} MB`)
  console.log('要重装就先删掉 manifest.json，或加 --root 换个目录。')
  process.exit(0)
}
if (done.reason) console.log(`当前状态：${done.reason}`)

const r = await installBrowser({ root, browser, log, smoke })
if (!r.ok) {
  console.error('\n❌ ' + r.message)
  if (r.missing) console.error('   缺的库：' + r.missing.join(', '))
  process.exit(1)
}
const info = installedInfo(root)
console.log('\n✅ 装好了')
console.log(`   浏览器：${r.browser}`)
console.log(`   种类：${r.kind}`)
console.log(`   占用：${Math.round((info?.sizeBytes || 0) / 1048576)} MB`)
console.log(`   冒烟：${r.manifest?.smokeOk ? '真的起得来' : '没测'}`)
