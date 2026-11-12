import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModuleContract } from '../src/core/module-contract.js'
import { planModules } from '../src/core/module-sdk.js'
import { styleModule } from '../src/modules/style/index.js'

test('style 是依赖 memory-store 与 reflection 观察事件的独立可选模块', () => {
  const def = validateModuleContract(styleModule)
  assert.deepEqual(def.provides, ['memory-style'])
  assert.deepEqual(def.requires, ['memory-store'])
  const memory = { id: 'memory', version: '1.0.0', setup: () => ({}), provides: ['memory-store'] }
  assert.deepEqual(planModules({ defs: [memory, styleModule], enabledOf: () => true, runtime: { gui: true } }).load.map((d) => d.id), ['memory', 'style'])
  assert.equal(planModules({ defs: [styleModule], enabledOf: () => true, runtime: { gui: true } }).load.length, 0)
})

test('style 消费 reflection 观察并记录来源，dispose 中止自我学习且零回写', async () => {
  const writes = []
  const handlers = new Map()
  const memory = {
    insightsOf: () => [],
    styleOf: () => [],
    styles: () => ({ 'qq:10002': ['短句', '爱叠字', '少用标点'] }),
    setDerivedStyle: (...args) => writes.push(args),
  }
  const service = styleModule.setup({
    use: () => memory,
    dsh: { llm: { async *stream() { await new Promise(() => {}) } } },
    config: () => ({ model: { provider: 'test', model: 'm' }, persona: { current: '' }, memory: {} }),
    log: { info() {}, warn() {} },
    context: () => {},
    on: (name, fn) => handlers.set(name, fn),
  })
  handlers.get('style/observed')({ key: 'qq:10002', list: ['短句回复'], sourceFingerprint: 'a'.repeat(64) })
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'qq:10002')
  assert.equal(writes[0][2].sourceFingerprint, 'a'.repeat(64))

  const pending = service.learnSelfStyle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  service.dispose()
  await pending
  assert.equal(writes.length, 1)
})
