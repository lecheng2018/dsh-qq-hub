import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distillModule } from '../src/modules/distill/index.js'

test('distill dispose 中止历史学习且不向模块 store 写入迟到画像', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-ownership-module-'))
  const routes = new Map()
  const records = Array.from({ length: 20 }, (_, index) => ({
    chatId: 'group:123', uid: '456', who: '小张', t: index + 1,
    text: `这是小张用于学习说话方式的第 ${index} 句原创内容`,
  }))
  const service = distillModule.setup({
    use: () => ({ distillList: () => [] }),
    dataDir: (name) => join(dir, name),
    dsh: { llm: { async *stream() { await new Promise(() => {}) } } },
    config: () => ({ enabled: true, model: { provider: 'test', model: 'm' }, persona: { current: '', groups: {} }, memory: { distill: true, distillPipeline: true } }),
    core: {
      hub: { groupNames: new Map() },
      chatLog: { listDays: () => ['2026-11-12'], readDay: () => records },
      http: { body: async () => ({}), query: () => ({}) },
    },
    log: { info() {}, warn() {}, debug() {} },
    context: () => {},
    on: () => {},
    every: () => {},
    emit: () => {},
    route: (name, fn) => routes.set(name, fn),
    setConfig: () => {},
  })
  t.after(() => {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const pending = service.learnFromHistory({ gid: '123', uid: '456', name: '小张' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  service.dispose()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal((await routes.get('/distill/list')()).list.length, 0)
})
