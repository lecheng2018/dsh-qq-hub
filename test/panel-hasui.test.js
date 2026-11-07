import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

// 把 client.js 里的 hasUi 抽出来实例化，防止「内置模块的配置项不渲染」这个 bug 回归。
function loadHasUi() {
  const m = src.match(/const hasUi = \(m\) => [^\n]+/)
  assert.ok(m, 'client.js 里应该还有 hasUi 定义')
  const expr = m[0].replace('const hasUi = ', '')
  return new Function('m', 'return (' + expr + ')(m)')
}

test('内置模块也要算「有界面」（配置项/面板要能渲染出来）', () => {
  const hasUi = loadHasUi()
  // 内置模块 running 是 'builtin'，以前 hasUi 要求 === 'user'，导致设置项和面板全不显示
  assert.equal(hasUi({ running: 'builtin', builtin: true, settings: [{ key: 'enabled' }], panel: false }), true,
    '内置模块有 settings 时必须算有界面')
  assert.equal(hasUi({ running: 'builtin', builtin: true, settings: [], panel: true }), true,
    '内置模块有 panel 时必须算有界面')
})

test('用户模块仍然正常', () => {
  const hasUi = loadHasUi()
  assert.equal(hasUi({ running: 'user', builtin: false, settings: [{ key: 'x' }], panel: false }), true)
  assert.equal(hasUi({ running: 'user', builtin: false, settings: [], panel: true }), true)
})

test('没在跑、或压根没界面的模块不占标签页', () => {
  const hasUi = loadHasUi()
  assert.equal(hasUi({ running: null, settings: [{ key: 'enabled' }], panel: true }), false)
  assert.equal(hasUi({ running: 'builtin', builtin: true, settings: [], panel: false }), false)
})

test('移植模块都声明了 settings，能在面板里露出开关', async () => {
  const ids = ['token-guardian', 'complete-guard', 'memory-privacy']  // security-lock 已移除
  for (const id of ids) {
    const mod = (await import(`../src/modules/${id}/index.js`)).default
    assert.ok(Array.isArray(mod.settings) && mod.settings.length > 0, `${id} 应该有 settings 配置项`)
    assert.ok(typeof mod.tab === 'string' && mod.tab, `${id} 应该声明 tab 以便嵌进对应标签页`)
  }
})
