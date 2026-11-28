// Batch 3 · T3.7：记忆档案 extend 契约回归 + 人设按会话解析
//
// 改前：
//   ① createMemoryArchive 收下 reflectImpl/styleImpl 却没透传给 extend(learning)，
//      模块侧自定义实现被静默丢弃 → 每轮整理都额外跑一次默认 LLM 反思（and 风格学习被绕开）；
//   ② modules/memory 的 personaText 只读 config.persona.current，分群人设的反思/风格
//      全部按主人 persona 落库。
// 这里跑真实 createMemoryStore 与真实模块导出函数。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/features/memory.js'
import { memoryPersonaText } from '../src/modules/memory/index.js'
import { currentPersonaText } from '../src/persona/personas.js'

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const yesterday = () => dayOf(new Date(Date.now() - 86400000))

function fixture(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b3-memory-extend-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const prompts = []
  const logs = new Map([[yesterday(), Array.from({ length: 6 }, (_, i) => ({ chatId: 'private:10002', who: '小张', text: `流水第 ${i} 条：我在调试记忆整理` }))]])
  const dsh = {
    get: () => null,
    llm: {
      async *stream(params) {
        prompts.push(String(params?.system || ''))
        yield { type: 'text-delta', text: '[]' }
      },
    },
  }
  const store = createMemoryStore({
    dsh,
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true } }),
    hub: { chatLogDays: () => [...logs.keys()], chatLogOf: (day) => logs.get(day) },
    log: { info() {}, warn() {} },
    ...opts,
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, prompts }
}

test('T3.7 reflectImpl 被透传到 learning：整理时用自定义反思，不再跑默认 LLM 反思', async (t) => {
  const reflectCalls = []
  const { store, prompts } = fixture(t, {
    reflectImpl: (chat, transcript, genSignal) => {
      reflectCalls.push({ chatId: chat?.kind === 'private' ? `private:${chat.userId}` : (chat?.id || chat?.chatId), lines: transcript?.length, genSignal: Boolean(genSignal) })
      return 0
    },
  })
  const r = await store.consolidate()
  assert.equal(r.ok, true, `整理应成功：${JSON.stringify(r.failed || [])}`)
  assert.equal(reflectCalls.length, 1, '自定义 reflectImpl 必须被调用一次')
  assert.equal(reflectCalls[0].chatId, 'private:10002')
  // 默认反思的提示词里会出现 {"insights" 的 JSON 契约；自定义实现生效时不该出现
  assert.equal(prompts.filter((p) => p.includes('{"insights"')).length, 0, '不许再回退调用默认 LLM 反思')
})

test('T3.7 styleImpl 被透传到 learning：learnSelfStyle 走自定义实现', async (t) => {
  let styleCalls = 0
  const { store, prompts } = fixture(t, {
    reflectImpl: () => 0,
    styleImpl: () => { styleCalls += 1; return 0 },
  })
  await store.learnSelfStyle()
  assert.equal(styleCalls, 1, '自定义 styleImpl 必须被调用')
  assert.equal(prompts.length, 0, '自定义风格实现生效时不许打默认 LLM')
})

test('T3.7 memoryPersonaText：按会话解析人设（群走群映射，私聊走当前人设）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-persona-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const cfg = {
    persona: {
      current: 'dafeiyu',
      groupDefault: 'group-main',
      groups: { 777: 'group-seven' },
      texts: { dafeiyu: '主人大肥鱼', 'group-main': '群通用人设', 'group-seven': '七群人设' },
    },
  }
  // 群 → 该群映射的人设；未映射的群 → groupDefault；私聊 → 当前人设
  assert.equal(memoryPersonaText({ kind: 'group', groupId: '777' }, cfg), currentPersonaText('group-seven'))
  assert.equal(memoryPersonaText({ kind: 'group', groupId: '888' }, cfg), currentPersonaText('group-main'))
  assert.equal(memoryPersonaText({ kind: 'private', userId: '10001' }, cfg), currentPersonaText('dafeiyu'))
  // 无 chat（历史调用方）→ 当前人设，不得变成空串
  assert.equal(memoryPersonaText(null, cfg), currentPersonaText('dafeiyu'))
  assert.ok(memoryPersonaText({ kind: 'group', groupId: '777' }, cfg).length > 0)
})
