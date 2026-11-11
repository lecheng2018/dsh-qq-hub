import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

let dir, cfg

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-lifecycle-test-'))
  process.env.AURABOT_DATA_DIR = dir
  cfg = {
    ownerQQ: '10001',
    model: { provider: 'test', model: 'test-model' },
    memory: { enabled: true, recallCount: 4 },
  }
})

test('lifecycle: dispose 幂等且关闭后操作明确被拒绝（B-01 规范）', () => {
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: console,
    personaText: () => '',
  })

  // 写入一条
  const r1 = store.add({ text: '测试事实1', scope: 'global' })
  assert.ok(r1.ok)

  // 首次 dispose
  store.dispose()

  // 重复调用 dispose 必须幂等，不抛错
  assert.doesNotThrow(() => store.dispose())
  assert.doesNotThrow(() => store.dispose())

  // 关闭后拒绝一切修改操作
  const r2 = store.add({ text: '关闭后的尝试', scope: 'global' })
  assert.equal(r2.ok, false)
  assert.equal(r2.message, '记忆模块已关闭')

  const r3 = store.remove('r1')
  assert.equal(r3.ok, false)
  assert.equal(r3.message, '记忆模块已关闭')

  const r4 = store.supersede({ oldId: 'r1', text: '新内容', scope: 'global' })
  assert.equal(r4.ok, false)
  assert.equal(r4.message, '记忆模块已关闭')
})

test('lifecycle: dispose 同步中止在途任务，迟到结果禁止写回（B-01 规范）', async () => {
  let abortObserved = false

  // 模拟一个挂起/慢速模型
  const fakeDsh = {
    llm: {
      stream: (params) => {
        return (async function* () {
          if (params.signal) {
            if (params.signal.aborted) {
              abortObserved = true
            } else {
              params.signal.addEventListener('abort', () => {
                abortObserved = true
              })
            }
          }
          // 模拟延迟挂起
          await new Promise((resolve) => setTimeout(resolve, 50))
          yield { type: 'text', text: '[{"op":"add","text":"迟到结果不应被记录","about":"10002"}]' }
        })()
      },
    },
  }

  const hubMock = {
    chatLogDays: () => ['2026-11-11'],
    chatLogOf: () => [
      { chatId: 'group:20001', who: '小张', uid: '10002', text: '我最近在学骑摩托车，上周刚报名考驾照' },
      { chatId: 'group:20001', who: '小李', uid: '10003', text: '考驾照容易挂科，注意练习慢速通过' },
      { chatId: 'group:20001', who: '小张', uid: '10002', text: '确实，我昨天差点摔了一跤，还好护具戴齐全了' },
      { chatId: 'group:20001', who: '小李', uid: '10003', text: '下周去哪里练车啊？' },
      { chatId: 'group:20001', who: '小张', uid: '10002', text: '就在北郊那个驾校场地练' },
      { chatId: 'group:20001', who: '小李', uid: '10003', text: '祝你一把过' },
      { chatId: 'group:20001', who: '小张', uid: '10002', text: '多谢啦' },
    ],
  }

  const store = createMemoryStore({
    dsh: fakeDsh,
    getConfig: () => cfg,
    hub: hubMock,
    log: console,
    personaText: () => '',
  })

  // 启动异步整理任务
  const taskPromise = store.consolidate({ includeToday: true })

  // 立即在飞调用 dispose
  store.dispose()

  await taskPromise

  // 验证 signal 收到 abort
  assert.ok(abortObserved, '在途请求必须收到 abort 信号')

  // 重开新实例核验：迟到结果绝不入库
  const store2 = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: console,
    personaText: () => '',
  })
  const hits = store2.recall('摩托车', { scopes: ['global', 'private:10001'] })
  assert.equal(hits.length, 0, '被取消任务的迟到结果绝不应写入存储')
  store2.dispose()
})

test('lifecycle: reload 接口重载外部对 memory.md 的手动修改（B-03 规范）', () => {
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: console,
    personaText: () => '',
  })

  // 初始写入
  store.add({ text: '小明喜欢吃苹果', scope: 'private:10001', about: '10001' })

  const initialHits = store.recall('苹果', { chat: { kind: 'private', userId: '10001' } })
  assert.equal(initialHits.length, 1)

  // 模拟主人直接在 NAS 上用记事本打开 memory.md 修改为 "小明喜欢吃西瓜"
  const mdFile = join(dir, 'memory', 'private', '10001', 'memory.md')
  const raw = readFileSync(mdFile, 'utf8')
  const edited = raw.replace('小明喜欢吃苹果', '小明喜欢吃西瓜')
  writeFileSync(mdFile, edited, 'utf8')

  // 调用 reload() 重载
  const reloadRes = store.reload()
  assert.equal(reloadRes.ok, true)

  // 验证索引立即更新
  const hitsWatermelon = store.recall('西瓜', { chat: { kind: 'private', userId: '10001' } })
  assert.equal(hitsWatermelon.length, 1)
  assert.ok(hitsWatermelon[0].it.text.includes('西瓜'))

  const hitsApple = store.recall('苹果', { chat: { kind: 'private', userId: '10001' } })
  assert.equal(hitsApple.length, 0, '旧事实在内存索引中已失效')

  store.dispose()
})
