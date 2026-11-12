import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { reflectionModule } from '../src/modules/reflection/index.js'
import { styleModule } from '../src/modules/style/index.js'
import { distillModule } from '../src/modules/distill/index.js'

function moduleApi(memory, dir, records) {
  return {
    use: () => memory,
    dataDir: (name) => join(dir, name),
    dsh: { llm: { async *stream() { await new Promise(() => {}) } } },
    config: () => ({ enabled: true, model: { provider: 'test', model: 'm' }, persona: { current: '', groups: {} }, memory: { enabled: true, distill: true, distillPipeline: true } }),
    core: {
      hub: { groupNames: new Map() },
      chatLog: { listDays: () => ['2026-11-12'], readDay: () => records },
      http: { body: async () => ({}), query: () => ({}) },
    },
    log: { info() {}, warn() {}, debug() {} },
    context: () => {}, on: () => {}, every: () => {}, emit: () => {}, route: () => {}, setConfig: () => {},
  }
}

test('连续启停 20 次：在途任务结束、process 监听器和计时器回到基线', async (t) => {
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const timers = new Set()
  global.setTimeout = (fn, ms, ...args) => {
    let timer
    timer = originalSetTimeout((...cbArgs) => {
      timers.delete(timer)
      return fn(...cbArgs)
    }, ms, ...args)
    timers.add(timer)
    return timer
  }
  global.clearTimeout = (timer) => {
    timers.delete(timer)
    return originalClearTimeout(timer)
  }
  const listeners = Object.fromEntries(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((name) => [name, process.listenerCount(name)]))
  t.after(() => {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
  })

  const records = Array.from({ length: 20 }, (_, index) => ({
    chatId: 'group:123', uid: '456', who: '小张', t: index + 1,
    text: `这是用于生命周期测试的第 ${index} 句原创内容`,
  }))
  for (let cycle = 0; cycle < 20; cycle++) {
    const dir = mkdtempSync(join(tmpdir(), `memory-lifecycle-20-${cycle}-`))
    process.env.DSH_QQ_HUB_DATA_DIR = dir
    const memory = createMemoryStore({
      dsh: { llm: { async *stream() { await new Promise(() => {}) } } },
      getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true, recallCount: 4, distill: true } }),
      log: { info() {}, warn() {} },
    })
    const reflection = reflectionModule.setup(moduleApi(memory, dir, records))
    const style = styleModule.setup(moduleApi(memory, dir, records))
    const distill = distillModule.setup(moduleApi(memory, dir, records))
    for (const text of ['偏好一', '偏好二', '偏好三']) memory.add({ text, about: '456', scope: 'private:456' })
    memory.setStyle('qq:456', ['短句', '爱叠字', '少用标点'])
    const chat = { kind: 'private', userId: '456', chatId: 'private:456', nickname: '小张' }
    const tasks = [
      memory.importCandidates('一段用于取消测试的旧档案'),
      memory.buildProfile('456', 'private:456'),
      memory.reflect(chat, '小张：今天有点累'),
      memory.learnSelfStyle(),
      memory.learnDistillFromHistory({ gid: '123', uid: '456' }),
      reflection.reflect(chat, '小张：今天有点累'),
      style.learnSelfStyle(),
      distill.learnFromHistory({ gid: '123', uid: '456' }),
    ]
    await new Promise((resolve) => setTimeout(resolve, 5))
    reflection.dispose()
    style.dispose()
    distill.dispose()
    memory.dispose()
    let watchdog
    const settled = await Promise.race([
      Promise.allSettled(tasks),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`第 ${cycle + 1} 轮任务未退出`)), 1000) }),
    ])
    clearTimeout(watchdog)
    assert.equal(settled.length, 8)
    memory.dispose()
    reflection.dispose()
    style.dispose()
    distill.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(timers.size, 0, '所有模型与代际计时器都已清理')
  for (const [name, count] of Object.entries(listeners)) assert.equal(process.listenerCount(name), count, `${name} 监听器未增长`)
})
