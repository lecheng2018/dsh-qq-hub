// 方案 B 回归测试：群聊隔离自动相处经验/自动说话方式/全局 self 串味，私聊保持完整，手工编辑仍生效。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryReflection } from '../src/features/memory-reflection.js'
import { createMemoryStyle } from '../src/features/memory-style.js'
import { reflectionModule } from '../src/modules/reflection/index.js'
import { styleModule } from '../src/modules/style/index.js'

const noopGen = () => ({
  signal: { signal: new AbortController().signal, isValid: () => true },
  cleanup() {},
})

test('reflection: 群聊跳过自动反思（不调模型、不落派生 SOP），私聊照常反思且按会话取人设护栏', async () => {
  let asked = []
  let writes = []
  let guardChats = []

  const svc = createMemoryReflection({
    dsh: {
      llm: {
        async *stream(params) {
          asked.push(params)
          yield { type: 'text-delta', text: '{"insights":["他晚上容易累"],"style":["短句回复"]}' }
        },
      },
    },
    getConfig: () => ({ model: { provider: 'test', model: 'm' }, persona: { current: 'p1', privateDefault: 'p2' } }),
    personaText: (chat) => {
      guardChats.push(chat)
      return chat?.kind === 'private' ? '禁止用波浪号' : '全局规则'
    },
    log: { info() {}, warn() {}, debug() {} },
    insightsOf: () => [],
    setDerivedInsights: (...args) => writes.push(args),
    styleOf: () => [],
    setStyle: () => {},
    createGenerationSignal: () => noopGen().signal,
    generationOf: noopGen,
    isActive: () => true,
  })

  // 群聊直接跳过
  const gCount = await svc.reflect({ kind: 'group', groupId: '10001' }, '甲：模型太贵了\n乙：换一家')
  assert.equal(gCount, 0)
  assert.equal(asked.length, 0, '群聊不得触发自动反思模型调用')
  assert.equal(writes.length, 0)

  // 私聊照常反思，且 personaText 收到的是私聊 chat 对象
  const pCount = await svc.reflect({ kind: 'private', userId: '10002', nickname: '小张' }, '小张：今天好累')
  assert.equal(pCount, 1)
  assert.equal(asked.length, 1)
  assert.equal(guardChats[0]?.kind, 'private')
  assert.match(asked[0].messages[0].content[0].text, /禁止用波浪号/)
})

test('reflectionModule context: 群聊仅注入手工相处经验，拦截派生 SOP；私聊全量注入', () => {
  let ctxFn = null
  const memory = {
    insightsOf: (key) => key === 'group:10001'
      ? [
          { id: 'd1', text: '推荐模型前先问清用途', origin: 'derived' },
          { id: 'm1', text: '群里少发长文', origin: 'manual' },
        ]
      : [{ id: 'p1', text: '他累的时候简单安慰就好', origin: 'derived' }],
    setDerivedInsights: () => {},
    styleOf: () => [],
  }

  reflectionModule.setup({
    use: () => memory,
    dsh: {},
    config: () => ({ persona: { current: '' }, memory: {} }),
    log: { info() {}, warn() {} },
    context: (fn) => { ctxFn = fn },
    emit: () => {},
  })

  const gCtx = ctxFn({ chat: { kind: 'group', groupId: '10001' } })
  assert.match(gCtx, /群里少发长文/, '手工写的群相处约定应生效')
  assert.doesNotMatch(gCtx, /推荐模型前先问清用途/, '自动派生的群 SOP 不得注入')

  const pCtx = ctxFn({ chat: { kind: 'private', userId: '10002' } })
  assert.match(pCtx, /简单安慰就好/, '私聊派生经验照常生效')
})

test('style: learnSelfStyle 不汇总群聊风格；styleModule 群聊不注入 self 与自动群风格，手工群风格仍生效', async () => {
  let selfModelCalled = 0
  const styleSvc = createMemoryStyle({
    dsh: {
      llm: {
        async *stream() {
          selfModelCalled += 1
          yield { type: 'text-delta', text: '["短句"]' }
        },
      },
    },
    getConfig: () => ({ model: { provider: 'test', model: 'm' }, persona: { current: '' } }),
    personaText: () => '',
    log: { info() {}, warn() {} },
    // 只有群聊风格（>=3 条），没有任何私聊风格
    styles: () => ({ 'group:10001': ['血亏', '一坨', '斩杀', '太难绷'] }),
    styleOf: () => [],
    setDerivedStyle: () => {},
    createGenerationSignal: () => noopGen().signal,
    generationOf: noopGen,
    isActive: () => true,
  })
  await styleSvc.learnSelfStyle()
  assert.equal(selfModelCalled, 0, 'learnSelfStyle 不得把群聊风格汇总进全局 self')

  // 验证 styleModule 路由与上下文隔离
  let ctxFn = null
  const handlers = new Map()
  const writes = []
  const memory = {
    styles: () => ({}),
    styleOf: (key) => {
      if (key === 'self') return ['全局self黑话']
      if (key === 'group:10001') return ['自动群黑话']
      if (key === 'group:10002') return ['手工群风格']
      if (key === 'qq:user-a') return ['私聊贴近语气']
      return []
    },
    styleSourceOf: (key) => {
      if (key === 'group:10001') return { origin: 'derived' }
      if (key === 'group:10002') return { origin: 'manual' }
      return { origin: 'derived' }
    },
    setDerivedStyle: (...args) => writes.push(args),
  }

  styleModule.setup({
    use: () => memory,
    dsh: {},
    config: () => ({ persona: { current: '' }, memory: {} }),
    log: { info() {}, warn() {} },
    context: (fn) => { ctxFn = fn },
    on: (ev, fn) => handlers.set(ev, fn),
  })

  // 群聊的 style/observed 事件应被忽略，不落库
  handlers.get('style/observed')({ key: 'group:10001', list: ['一坨'], sourceFingerprint: 'a'.repeat(64) })
  assert.equal(writes.length, 0, '群聊不得写入自动派生风格')

  // 群 10001（只有 derived 群风格 + 全局 self）：上下文必须为空
  assert.equal(ctxFn({ chat: { kind: 'group', groupId: '10001' } }), '')

  // 群 10002（有 manual 群风格 + 全局 self）：只注入手工群风格，绝不注入 self
  const g2Ctx = ctxFn({ chat: { kind: 'group', groupId: '10002' } })
  assert.match(g2Ctx, /手工群风格/)
  assert.doesNotMatch(g2Ctx, /全局self黑话/)

  // 私聊：照常注入私聊风格与 self
  const pCtx = ctxFn({ chat: { kind: 'private', userId: 'user-a' } })
  assert.match(pCtx, /私聊贴近语气/)
  assert.match(pCtx, /全局self黑话/)
})
