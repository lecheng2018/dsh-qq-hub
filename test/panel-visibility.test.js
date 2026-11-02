// 面板可见性回归：内置模块的设置项要能透出来，前端拼的路由要能命中真实路由。
// 这两个 bug 曾导致五个新模块的配置界面在 DSH 里整个不显示。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

let fake, api
const NEW_MODS = ['token-guardian', 'security-lock', 'memory-privacy', 'slang-learner', 'complete-guard']

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-vis-'))
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '10000001', botQQ: '20000002', dataDir,
    snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'ns') },
    voice: { engine: 'none', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0 },
  }))
  fake = createFakeDsh({ brain: () => '好' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await new Promise((r) => setTimeout(r, 1200))
})

after(() => { fake?.dispose(); setTimeout(() => process.exit(0), 100).unref() })

test('内置模块的设置项能透出去（否则面板渲染不出开关）', () => {
  const list = api.modules.status()
  for (const id of NEW_MODS) {
    const m = list.find((x) => x.id === id)
    assert.ok(m, `${id} 应该在模块列表里`)
    assert.ok((m.settings || []).length > 0, `${id} 的 settings 不该是空数组`)
  }
})

test('前端按模块来源拼出的路由能命中真实路由', () => {
  const list = api.modules.status()
  const paths = {
    'token-guardian': '/token-guardian/status',
    'security-lock': '/security-lock/status',
    'memory-privacy': '/memory-privacy/stats',
    'slang-learner': '/slang-learner/list',
    'complete-guard': '/complete-guard/last',
  }
  for (const [id, p] of Object.entries(paths)) {
    const m = list.find((x) => x.id === id)
    // 和 client/client.js 里的算法保持一致
    const base = m.builtin && m.running === 'builtin' ? '' : '/ext/' + m.id
    const url = '/aurabot/api' + base + p
    assert.ok(api.modules.hasRoute(url), `${id} 的面板路由 ${url} 应该存在`)
  }
})

test('内置模块的面板不该被拼成 /ext/ 前缀', () => {
  const list = api.modules.status()
  for (const id of NEW_MODS) {
    const m = list.find((x) => x.id === id)
    const base = m.builtin && m.running === 'builtin' ? '' : '/ext/' + m.id
    assert.equal(base, '', `${id} 是内置模块，不该有 /ext/ 前缀`)
  }
})
