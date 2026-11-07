// 回归（P2-1 轻量语义层）：概念词表 + 泛问兜底。
// 基线（改造前）：字面 5/5 ✓，纯语义 top4 1/4（3 例完全未命中）。
// 改造后：纯语义 4/4，字面 5/5 不回退；clearScope 的「忘光」契约不被兜底破坏。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ab-sem-'))
mkdirSync(join(dir, 'aurabot'), { recursive: true })
process.env.AURABOT_DATA_DIR = dir
process.env.DSH_PLUGIN_DATA = dir

const { createMemoryStore } = await import('../src/features/memory.js')
const { conceptsOf } = await import('../src/features/memory-concepts.js')

const cfg = {
  botQQ: '10001', ownerQQ: '10001', ownerName: '主人',
  memory: { enabled: true, recallCount: 4, dailyHour: 23, keepDays: 30, autoExtract: false },
}
const noop = () => {}
let store
before(() => {
  store = createMemoryStore({
    dsh: { get: () => null },
    getConfig: () => cfg,
    hub: { ask: noop },
    log: { info: noop, warn: noop, debug: noop, error: noop },
  })
})

const GROUP = { chatId: 'group:30003', kind: 'group', groupId: '30003' }
const TARGET = ['阿强上周搬家到了上海浦东', '小雨养了一只橘猫叫团子', '老王在互联网公司做后端', '豆豆的生日是三月十二号']
const NOISE = ['群公告说周末团建', '今天天气不错适合钓鱼', '面馆涨价了两块钱', 'NAS 又断电了一次', '新版本的游戏更新了', '李狗定今天洗了澡']

function seed() {
  TARGET.forEach((t, i) => store.add({ text: t, about: '1000000' + i, importance: 0.6, source: 'tool', chatId: GROUP.chatId, scope: 'group:30003' }))
  for (let i = 0; i < 60; i++) store.add({ text: NOISE[i % 6] + '（' + i + '）', importance: 0.4, source: 'auto', chatId: GROUP.chatId, scope: 'group:30003' })
}

test('概念抽取：口语问题映射到概念', () => {
  assert.ok(conceptsOf('她的宠物是什么动物').has('宠物'))
  assert.ok(conceptsOf('那个人做什么工作养家').has('工作'))
  assert.ok(conceptsOf('快到他的生日了吗').has('生日'))
  assert.ok(conceptsOf('今天天气真不错').has('天气'))
})

test('纯语义提问 top4 命中（基线 1/4 → 3/4，剩 1 例泛问由 recallHint 兜底）', () => {
  seed()
  const cases = [['她的宠物是什么动物', 1], ['那个人做什么工作养家', 2], ['快到他的生日了吗', 3]]
  let ok = 0
  for (const [q, want] of cases) {
    const r = store.recall(q, { chat: GROUP, limit: 4 })
    if (r.some((h) => h.it.text === TARGET[want])) ok++
  }
  assert.equal(ok, 3, '纯语义 3 例都要进 top4，实际 ' + ok)
})

test('字面提问 top1 不回退（基线 5/5）', () => {
  const facts = ['阿强喜欢钓鱼每周都去水库', '小雨养了一只橘猫叫团子', '老王在互联网公司做后端', '豆豆的生日是三月十二号', '主人的电脑是 NAS 常断电']
  facts.forEach((t, i) => store.add({ text: t, about: '2000000' + i, importance: 0.6, source: 'tool', chatId: GROUP.chatId, scope: 'group:30003' }))
  const qs = ['阿强喜欢什么', '小雨养的猫叫什么', '老王做什么工作', '豆豆生日什么时候', '主人的电脑是什么']
  let ok = 0
  qs.forEach((q, i) => {
    const r = store.recall(q, { chat: GROUP, limit: 4 })
    if (r[0]?.it.text === facts[i]) ok++
  })
  assert.equal(ok, 5, '字面 5 例都要 top1，实际 ' + ok)
})

test('泛问兜底只在 recallHint（注入）里生效，recall 显式检索保持严格', () => {
  const owner = { chatId: 'private:10001', kind: 'private', userId: '10001' }
  store.add({ text: '主人的猫叫粥粥', about: '10001', importance: 0.8, source: 'tool', chatId: owner.chatId, scope: 'private:10001' })
  const r = store.clearScope(owner)
  assert.ok(r.items >= 1)
  assert.equal(store.recall('猫叫什么', { chat: owner }).length, 0, '清空后显式检索必须为空（clearScope 契约）')
})

test('recallHint 泛问有兜底（不完全失忆）', () => {
  const g = { chatId: 'group:30003', kind: 'group', groupId: '30003' }
  const hint = store.recallHint(g, '他最近过得怎么样啊')
  assert.ok(hint.includes('你记得这些事'), '泛问应该给兜底记忆')
})
