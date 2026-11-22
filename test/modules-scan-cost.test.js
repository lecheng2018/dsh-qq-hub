// 审计 Q19 的回归锁：模块扫描/预加载的两处代价与安全。
//
// 修复过程记录（值得钉住的两个真缺陷）：
//   ① loadLib 是**模块级导出**，模块作用域里没有 createModules 内部的 log。
//      给它补日志时直接写 log.debug(...)，catch 分支一执行就 ReferenceError。
//      而 src/modules/*/panel.js 含 JSX、在这里 import 必然失败——于是每次 boot
//      都必进 catch、必然抛错，模块一个都起不来（modules.test.js 当场 9 连挂）。
//      → loadLib 改为显式接受可选 logger，用法 log?.debug?.()，无 logger 也安全。
//   ② status() 曾用 1.5s TTL 缓存用户模块扫描结果，立刻被 modules.test.js 打回：
//      写入模块目录后立刻读 status 拿到旧列表。status 不只是展示，测试与面板都
//      依赖它反映最新目录。
//      → 改为复用 boot/sync 刚扫出的结果（rememberUsers），不引入独立于目录状态的陈旧窗口。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModules, loadLib } from '../src/core/modules.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet }

// 注意：loadLib 有模块级缓存（加载过就直接返回），所以这两件事必须在**同一个**
// 用例里、且「带 logger 的冷缓存调用」在前——否则第二次调用命中缓存，日志永远不会发生
// （第一版就是这么写错的：第二个用例恒失败，因为缓存已被第一个用例填满）。
test('Q19 · loadLib 的日志走显式传入的 logger；无 logger 时也不抛', async () => {
  const seen = []
  const log = { info() {}, warn() {}, error() {}, debug: (m) => seen.push(String(m)), child: () => log }

  // 冷缓存 + 有 logger：应记录下无法作为 ES 模块加载的内部文件（panel.js 等）
  const cache = await loadLib(log)
  assert.ok(cache instanceof Map && cache.size > 0, '应缓存到若干内部模块')
  assert.ok(seen.length > 0, '存在无法作为 ES 模块加载的内部文件（panel.js 等），应有 debug 记录')
  assert.ok(seen.every((m) => m.includes('lib 跳过')), `日志格式应可辨识：${seen.slice(0, 2)}`)

  // 无 logger：模块作用域没有 createModules 里的 log，绝不能因日志语句抛错
  await assert.doesNotReject(() => loadLib(), 'loadLib() 无 logger 时应安全返回')
})

test('Q19 · status() 反映最新模块目录（不允许独立于目录状态的陈旧缓存）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqhub-scan-'))
  const modsDir = join(dataDir, 'modules')
  mkdirSync(modsDir, { recursive: true })
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir

  const ctx = { effect: (fn) => { const off = fn?.(); return () => { try { off?.() } catch {} } }, get: () => null }
  const mods = createModules({
    ctx,
    core: { bridge: { refresh() {} }, hub: {}, http: { body: async () => ({}) } },
    getConfig: () => ({ ownerQQ: '1', ext: {} }),
    setConfig: () => {},
    logger: quiet,
    version: 't',
    builtins: [],
  })

  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(mods.status().length, 0, '起步没有任何模块')

    // 写一个最小用户模块后立刻读 status —— 这正是 TTL 方案失败的场景
    const dir = join(modsDir, 'probe')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), 'export default { id: "probe", name: "探针", version: "1.0.0", api: 1, setup() { return {} } }\n')
    await mods.sync()
    assert.ok(
      mods.status().some((m) => m.id === 'probe'),
      'sync 之后 status 必须立刻看到新模块（不允许拿到旧扫描结果）',
    )
  } finally {
    await mods.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
