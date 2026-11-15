// 回归（真机 1.4.6：抖音页整页崩「Cannot read properties of undefined (reading 'length')」）：
// 六个上商店的模块里，bili/douyin/heybox/multi-parser/qzone-social 的面板页留在核心包
// （client/src/views/platforms/ 与 diary.js），直接打这些模块的**无前缀**路由；
// 但 #163 把它们从内置清单移除后，内核按 builtinDefs 判断前缀，把这些路由挂到了 /ext/<id>/ 下
// ——面板页 404，state.history 读不到，整页崩。挂载规则改为 routePrefixFor()：
// 内置 or 面板在核心包 → 无前缀；其余 → /ext/<id>。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { routePrefixFor, OPTIONAL_MODULE_IDS } from '../src/core/modules.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('核心包带面板页的五个模块：无论内置还是商店装，路由都挂无前缀', () => {
  for (const id of ['bili', 'douyin', 'heybox', 'multi-parser', 'qzone-social']) {
    assert.equal(routePrefixFor(id, false), '', `${id} 商店装上来也要挂无前缀路由（核心面板页直接打它）`)
    assert.equal(routePrefixFor(id, true), '', `${id} 内置时无前缀`)
  }
})

test('其余模块：内置无前缀、商店装挂 /ext/<id>', () => {
  assert.equal(routePrefixFor('delivery-inbox', false), '/ext/delivery-inbox', 'delivery-inbox 自带 panel.js，走 /ext/ 前缀（ExtPage 的绑定 call 自己拼前缀）')
  assert.equal(routePrefixFor('weather', false), '/ext/weather', '真正的新模块挂 /ext/<id>')
  assert.equal(routePrefixFor('voice', true), '', '内置模块无前缀')
})

test('核心面板 id 清单 ⊆ 已上商店的可选模块清单，且挂载点真的用了 routePrefixFor', () => {
  const src = readFileSync(join(ROOT, 'src/core/modules.js'), 'utf8')
  for (const m of src.matchAll(/CORE_PANEL_IDS = new Set\(\[([^\]]*)\]\)/g)) {
    const ids = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    for (const id of ids) assert.ok(OPTIONAL_MODULE_IDS.includes(id), `${id} 在 CORE_PANEL_IDS 里但不在 OPTIONAL_MODULE_IDS——两份清单要同步维护`)
  }
  assert.match(src, /routePrefixFor\(id, builtinDefs\.has\(id\)\)/, 'makeApi 的路由挂载要走 routePrefixFor，不能回退成按 builtinDefs 判断')
})
