// 身份中枢的接线回归：换卡后后台链路真的换名字（PR #108 的阻塞项 B1）。
//
// 这个文件守的不是「函数返回什么」，而是「换一张人设卡，后台发给模型的提示词里是不是新名字」。
// 阶段 0a 建了中枢却没人消费，等于没修「前台换人、后台念旧名」的根因；这些用例钉住三条
// 最容易串味的链路（记忆提炼 / 长期反思 / 语感学习）+ 群唤醒词，以及按群人设的分流。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 每个用例一个独立数据目录：人设卡是文件，混用目录会让「有没有卡」变成环境依赖。
 * 返回装卡的函数（卡名写进临时目录，globalId/perGroup 由用例自己指定）。
 */
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-wiring-'))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  delete process.env.AURABOT_DATA_DIR
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir }
}

/** 捕获每次 askModel 的入参，并按顺序吐回预设输出。 */
function dshCapturing(params, outputs) {
  return {
    llm: {
      async *stream(input) {
        params.push(input)
        yield { type: 'text-delta', text: outputs[Math.min(params.length - 1, outputs.length - 1)] }
      },
    },
  }
}

const baseCfg = (persona = {}) => ({
  ownerQQ: '10001',
  botQQ: '20002',
  ownerName: '主人',
  model: { provider: 'test', model: 'm' },
  persona,
})

test('记忆提炼：提示词里的角色名跟着卡走，不再写死', async (t) => {
  sandbox(t)
  const { savePersona } = await import('../src/persona/personas.js')
  savePersona('card-bai', { name: '小白鲸', body: '你是小白鲸。' })
  const { createMemoryExtractor } = await import('../src/features/memory-extractor.js')
  const params = []
  const extractor = createMemoryExtractor({
    dsh: dshCapturing(params, ['[{"text":"小明不吃香菜","about":"小明"}]']),
    getConfig: () => baseCfg({ current: 'card-bai' }),
    relatedTo: () => [],
    commit: () => true,
    isActive: () => true,
  })
  assert.equal(await extractor.extractFacts('private:10002', '小明：我不吃香菜'), 1)
  assert.match(params[0].system, /你帮一个叫「小白鲸」的聊天角色/)
  assert.doesNotMatch(params[0].system, /大肥鱼/, '换卡后不该再出现旧名字')
})

test('记忆提炼：认自己是靠身份中枢的自称正则，不是写死的「大肥鱼」', async (t) => {
  sandbox(t)
  const { savePersona } = await import('../src/persona/personas.js')
  savePersona('card-bai', { name: '小白鲸', body: '你是小白鲸。' })
  const { createMemoryExtractor } = await import('../src/features/memory-extractor.js')
  const params = []
  const committed = []
  const extractor = createMemoryExtractor({
    dsh: dshCapturing(params, ['[{"text":"关于她自己的条目","about":"小白鲸"},{"text":"小明不吃香菜","about":"小明"},{"text":"我自己的习惯","about":"我"}]']),
    getConfig: () => baseCfg({ current: 'card-bai' }),
    relatedTo: () => [],
    commit: (item) => { committed.push(item.about); return true },
    isActive: () => true,
  })
  await extractor.extractFacts('private:10002', '内容')
  assert.deepEqual(committed, ['小明'], '她自己（卡名/我）的条目不该落成关于别人的事实')
})

test('按群人设分流：同一个后台链路，不同群用各自的卡', async (t) => {
  sandbox(t)
  const { savePersona } = await import('../src/persona/personas.js')
  savePersona('card-bai', { name: '小白鲸', body: '你是小白鲸。' })
  savePersona('card-jing', { name: '小鲸', body: '你是小鲸。' })
  const { createMemoryExtractor } = await import('../src/features/memory-extractor.js')
  const params = []
  const extractor = createMemoryExtractor({
    dsh: dshCapturing(params, ['[]']),
    getConfig: () => baseCfg({ current: 'card-bai', groups: { 777: 'card-jing' } }),
    relatedTo: () => [],
    commit: () => true,
    isActive: () => true,
  })
  await extractor.extractFacts('group:777', '群聊内容')
  await extractor.extractFacts('group:888', '群聊内容')
  assert.equal(params.length, 2)
  assert.match(params[0].system, /「小鲸」/, '指定了卡的那个群用自己的卡')
  assert.match(params[1].system, /「小白鲸」/, '没指定的群回落全局卡')
})

test('长期反思：提示词署名跟着这个聊天实际用的卡', async (t) => {
  sandbox(t)
  const { savePersona } = await import('../src/persona/personas.js')
  savePersona('card-bai', { name: '小白鲸', body: '你是小白鲸。' })
  const { createMemoryReflection } = await import('../src/features/memory-reflection.js')
  const params = []
  let resolveGen
  const service = createMemoryReflection({
    dsh: dshCapturing(params, ['{"insights":["他累的时候少说一点"],"style":["短句回复"]}']),
    getConfig: () => baseCfg({ current: 'card-bai' }),
    personaText: () => '你是小白鲸。',
    log: { info() {}, warn() {}, debug() {} },
    insightsOf: () => [],
    setDerivedInsights: () => {},
    styleOf: () => [],
    setStyle: () => {},
    createGenerationSignal: () => { resolveGen = { isValid: () => true, signal: null, cleanup() {} }; return resolveGen },
    generationOf: (external) => ({ signal: external || resolveGen, cleanup: () => {} }),
    isActive: () => true,
  })
  // reflect 内部先 generationOf(null)，再校验 signal.isValid()
  resolveGen = { isValid: () => true, signal: null, cleanup: () => {} }
  await service.reflect({ kind: 'private', userId: '10002', chatId: 'private:10002' }, '小张：今天有点累')
  assert.match(params[0].system, /你是「小白鲸」/)
  assert.doesNotMatch(params[0].system, /大肥鱼/)
})

test('语感学习：全局沉淀用全局那张卡的名字', async (t) => {
  sandbox(t)
  const { savePersona } = await import('../src/persona/personas.js')
  savePersona('card-bai', { name: '小白鲸', body: '你是小白鲸。' })
  const { createMemoryStyle } = await import('../src/features/memory-style.js')
  const params = []
  const service = createMemoryStyle({
    dsh: dshCapturing(params, ['["嗯嗯","好嘞"]']),
    getConfig: () => baseCfg({ current: 'card-bai' }),
    personaText: () => '你是小白鲸。',
    log: { info() {}, warn() {}, debug() {} },
    styles: () => ({ 'qq:1': ['hhh', '草', '好家伙'] }),
    styleOf: () => [],
    setDerivedStyle: () => {},
    createGenerationSignal: () => ({ isValid: () => true, signal: null, cleanup() {} }),
    generationOf: (external) => ({ signal: external || { isValid: () => true, signal: null, cleanup() {} }, cleanup: () => {} }),
    isActive: () => true,
  })
  await service.learnSelfStyle()
  assert.match(params[0].system, /你是「小白鲸」/)
  assert.doesNotMatch(params[0].system, /大肥鱼/)
})

test('群唤醒词：卡名并进唤醒词，但没卡时不乱加兜底名', async () => {
  const { DEFAULT_GROUP_POLICY, withRoleWakeWords, policyFor } = await import('../src/chat/group-policy.js')
  const pol = policyFor({}, {}, '777')
  const withCard = withRoleWakeWords(pol, { name: '小鲸', hasCard: true })
  assert.deepEqual(withCard.wakeWords.slice(0, 1), ['小鲸'], '换卡后喊新名字要叫得动')
  assert.deepEqual(withCard.wakeWords, ['小鲸', ...DEFAULT_GROUP_POLICY.wakeWords], '原有唤醒词不能丢')
  const noCard = withRoleWakeWords(pol, { name: 'AI伴侣', hasCard: false })
  assert.deepEqual(noCard.wakeWords, DEFAULT_GROUP_POLICY.wakeWords, '兜底名不该变成唤醒词')
  const dup = withRoleWakeWords(pol, { name: DEFAULT_GROUP_POLICY.wakeWords[0], hasCard: true })
  assert.deepEqual(dup.wakeWords, DEFAULT_GROUP_POLICY.wakeWords, '已经在列表里的不重复加')
})
