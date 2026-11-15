// 回归：内置模块写的 `tab` 必须是面板里真实存在的标签页 id。
// 写错/写了后来被删掉的 tab id 不会报错——page.js 的 intoTab() 判定为「没落点」，
// 于是模块掉进 ext:<id> 的散装标签页机制，表现为「系统页莫名多出一排」
// （真机 2026-11-15：token-billing 的 tab:'token' 悬空 + P1–P5 五个模块没写 tab）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BUILTINS } from '../src/modules/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// TAB_ALIAS 与 page.js 保持一致（mood 是老名字，归一成 memory）
const TAB_ALIAS = { mood: 'memory' }

/** 面板内置标签页 id（从 nav.js 源码抽，避免在 node 里加载浏览器侧 react）。 */
function tabIds() {
  const src = readFileSync(join(ROOT, 'client/src/domain/nav.js'), 'utf8')
  const block = src.match(/const TABS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'nav.js 里应该还能找到 TABS 数组')
  return [...block[1].matchAll(/\{ id: '([A-Za-z0-9_]+)'/g)].map((m) => m[1])
}

test('内置模块写的 tab 必须真实存在（悬空 tab = 掉进散装页）', () => {
  const ids = new Set(tabIds())
  assert.ok(ids.size >= 15, `抽到的标签页太少（${ids.size}），先确认 nav.js 的解析没坏`)
  // 只查「写了 tab 但那个页不存在」这一种：它是 token-billing 踩到的坑。
  // 「有界面但没写 tab」是另一种取舍（自成一站扩展页，P1–P5 在 #168 里统一改嵌「QQ 增强」），不在这里判错。
  const offenders = []
  for (const m of BUILTINS) {
    if (!m.tab) continue
    const target = TAB_ALIAS[m.tab] || m.tab
    if (!ids.has(target)) offenders.push(`${m.id}: tab='${m.tab}' 在 TABS 里不存在`)
  }
  assert.deepEqual(offenders, [], `这些模块的 tab 悬空，会掉进散装标签页：\n${offenders.join('\n')}`)
})

test('「用量」页收着 token 系三个模块，模型页不再挂它们', () => {
  const byId = (id) => BUILTINS.find((m) => m.id === id)
  for (const id of ['token-billing', 'token-guardian', 'complete-guard']) {
    assert.equal(byId(id)?.tab, 'token', `${id} 应该嵌在「用量」页`)
  }
  const src = readFileSync(join(ROOT, 'client/src/domain/nav.js'), 'utf8')
  assert.match(src, /token: \['token-billing', 'token-guardian', 'complete-guard'\]/, 'TAB_MODS.token 要绑这三个模块（都没跑就整页隐藏）')
  // 只锁「用量排在模型之后」这条相对顺序——中间还可能插别的页（#168 就插了「QQ 增强」），别锁整串字面量
  const sysTabs = (src.match(/id: 'system'[\s\S]*?tabs: \[([^\]]*)\]/) || [])[1] || ''
  const order = [...sysTabs.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  assert.ok(order.includes('model') && order.includes('token'), `系统分组里要有「模型」和「用量」，实际：${order.join('/')}`)
  assert.ok(order.indexOf('model') < order.indexOf('token'), '「用量」排在「模型」之后')
})
