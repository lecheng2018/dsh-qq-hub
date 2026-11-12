import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModuleContract } from '../src/core/module-contract.js'
import { planModules } from '../src/core/module-sdk.js'
import { reflectionModule } from '../src/modules/reflection/index.js'

test('reflection 是依赖 memory-store 的独立可选模块', () => {
  const def = validateModuleContract(reflectionModule)
  assert.deepEqual(def.provides, ['memory-reflection'])
  assert.deepEqual(def.requires, ['memory-store'])
  const memory = { id: 'memory', version: '1.0.0', setup: () => ({}), provides: ['memory-store'] }
  assert.deepEqual(planModules({ defs: [memory, reflectionModule], enabledOf: () => true, runtime: { gui: true } }).load.map((d) => d.id), ['memory', 'reflection'])
  const withoutMemory = planModules({ defs: [reflectionModule], enabledOf: () => true, runtime: { gui: true } })
  assert.equal(withoutMemory.load.length, 0)
})


test('reflection dispose 中止独立模型任务且禁止迟到写入', async () => {
  const writes = []
  let contextProvider
  const memory = {
    insightsOf: () => [],
    setDerivedInsights: (...args) => writes.push(args),
    styleOf: () => [],
    setStyle: (...args) => writes.push(args),
  }
  const service = reflectionModule.setup({
    use: () => memory,
    dsh: { llm: { async *stream() { await new Promise(() => {}) } } },
    config: () => ({ model: { provider: 'test', model: 'm' }, persona: { current: '' }, memory: {} }),
    log: { info() {}, warn() {} },
    context: (fn) => { contextProvider = fn },
  })
  const pending = service.reflect({ kind: 'private', userId: '10002', nickname: '小张' }, '小张：今天有点累')
  await new Promise((resolve) => setTimeout(resolve, 20))
  service.dispose()
  await assert.rejects(pending, /中止|取消|disposed/)
  assert.equal(writes.length, 0)
  assert.equal(contextProvider({ chat: { kind: 'private', userId: '10002' } }), '')
})
