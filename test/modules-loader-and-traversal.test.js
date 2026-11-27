// 回归：core/modules.js loadLib 排除 panel*.js/host.js/modules/*/index.js、panelSource 防目录穿越、sync 停掉计划外运行中内置模块。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLib, lib, libKeys, createModules } from '../src/core/modules.js'

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {},
  child: () => noopLog,
}

test('loadLib() 显式排除 panel*.js、host.js、modules/*/index.js，不报 Illegal return statement', async () => {
  const debugs = []
  await loadLib({ debug: (m) => debugs.push(String(m)) })
  const keys = libKeys()
  assert.ok(keys.includes('core/store.js'), '普通内部文件仍可通过 lib() 访问')
  assert.equal(keys.includes('host.js'), false, '不得暴露 host.js')
  assert.equal(keys.some((k) => /(^|\/)panel[^/]*\.js$/i.test(k)), false, '不得加载 panel*.js')
  assert.equal(keys.some((k) => /^modules\/[^/]+\/index\.js$/.test(k)), false, '不得暴露 modules/*/index.js')
  assert.throws(() => lib('host.js'))
  assert.throws(() => lib('modules/purpose/panel.js'))
  assert.throws(() => lib('modules/purpose/index.js'))
  assert.equal(debugs.some((m) => m.includes('Illegal return statement')), false, '启动不得再出现 panel.js 语法跳过日志')
})

test('panelSource() 用 relative() 拦截同级前缀绕过与 .. / 绝对路径穿越', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqhub-mod-trav-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  process.env.AURABOT_DATA_DIR = dataDir

  const modRoot = join(dataDir, 'modules')
  // 同级目录前缀：evil 与 evil-secret（旧版 file.startsWith(u.dir) 会被 ../evil-secret/secret.js 绕过！）
  mkdirSync(join(modRoot, 'evil', 'sub'), { recursive: true })
  mkdirSync(join(modRoot, 'evil-secret'), { recursive: true })
  writeFileSync(join(modRoot, 'evil-secret', 'secret.js'), 'SECRET_PAYLOAD', 'utf8')
  writeFileSync(join(modRoot, 'evil', 'sub', 'ok.js'), 'SAFE_PANEL', 'utf8')

  const makeMods = (panelSpec) => {
    writeFileSync(
      join(modRoot, 'evil', 'index.mjs'),
      `export default { id: 'evil', name: 'Evil', version: '1.0.0', api: 1, panel: ${JSON.stringify(panelSpec)}, setup() {} }\n`,
      'utf8',
    )
    const ctx = { effect: (fn) => { const off = fn?.(); return () => { try { off?.() } catch {} } }, get: () => null }
    return createModules({
      ctx,
      core: { bridge: { refresh() {} }, hub: {}, http: { body: async () => ({}) } },
      getConfig: () => ({ modules: { userModules: true } }),
      setConfig: (c) => c,
      logger: noopLog,
      version: 'test',
      builtins: [],
    })
  }

  try {
    for (const badSpec of ['../evil-secret/secret.js', '../secret.js', join(modRoot, 'evil-secret', 'secret.js')]) {
      const mods = makeMods(badSpec)
      try {
        await mods.sync()
        assert.equal(mods.panelSource('evil'), null, `应拦截越界 panel 路径：${badSpec}`)
      } finally {
        mods.dispose()
      }
    }

    const okMods = makeMods('sub/ok.js')
    try {
      await okMods.sync()
      assert.equal(okMods.panelSource('evil'), 'SAFE_PANEL', '模块目录内合法子路径应可正常读取')
    } finally {
      okMods.dispose()
    }
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('sync()：运行中的内置模块在依赖失效变为 !planned 时必须被立即停掉', async () => {
  let cfg = { modules: { provider: { enabled: true }, consumer: { enabled: true } } }
  let consumerStopped = 0
  const ctx = { effect: (fn) => { const off = fn?.(); return () => { try { off?.() } catch {} } }, get: () => null }
  const mods = createModules({
    ctx,
    core: { bridge: { refresh() {} }, hub: {}, http: { body: async () => ({}) } },
    getConfig: () => cfg,
    setConfig: (c) => { cfg = c; return cfg },
    logger: noopLog,
    version: 'test',
    builtins: [
      { id: 'provider', name: 'Provider', version: '1.0.0', api: 1, provides: ['cap-x'], setup() { return {} } },
      { id: 'consumer', name: 'Consumer', version: '1.0.0', api: 1, requires: ['cap-x'], setup(api) { api.onDispose(() => { consumerStopped++ }); return {} } },
    ],
  })
  try {
    await mods.boot()
    await mods.sync()
    let running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(running.includes('provider') && running.includes('consumer'))

    // 禁用 provider 后 sync()：即使 consumer 自身配置仍是 enabled=true，也不在 planned 中，必须停掉！
    cfg = { modules: { provider: { enabled: false }, consumer: { enabled: true } } }
    await mods.sync()
    running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.equal(running.includes('provider'), false)
    assert.equal(running.includes('consumer'), false, '计划外的运行中内置模块不得被 short-circuit 留活')
    assert.ok(consumerStopped >= 1)
  } finally {
    mods.dispose()
  }
})
