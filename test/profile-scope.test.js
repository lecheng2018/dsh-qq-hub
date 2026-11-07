// 人物小档案（profile）必须按聊天作用域隔离：
// 私聊里聊出来的私事，不能通过 profileOf(qq) 流到群聊上下文里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'aurabot-profile-scope-'))
process.env.AURABOT_DATA_DIR = DIR

const { createMemoryStore } = await import('../src/features/memory.js')
const noop = () => {}
const cfg = { botQQ: '3457241415', ownerQQ: '10000001', ownerName: '主人',
  memory: { enabled: true, recallCount: 8, dailyHour: 23, keepDays: 30, autoExtract: true } }
const mem = createMemoryStore({
  dsh: { get: () => null }, getConfig: () => cfg,
  hub: { ask: noop, speakersOf: () => ['10000001'] },
  log: { info: noop, warn: noop, debug: noop, error: noop },
})

const G = { chatId: 'group:222333444', kind: 'group', groupId: '222333444' }
const P = { chatId: 'private:10000001', kind: 'private', userId: '10000001' }

test('私聊攒的档案不出现在群聊上下文里', () => {
  mem.setProfile('10000001', '兜里只有十块钱，猫叫粥粥', '主人', mem.scopeOfChat(P))
  const ctx = mem.contextFor(G, 's1')
  assert.ok(!ctx.includes('十块钱'), '群聊上下文里不该出现私聊的十块钱')
  assert.ok(!ctx.includes('粥粥'), '群聊上下文里不该出现私聊的猫名')
})

test('私聊自己的档案照常读取', () => {
  const ctx = mem.contextFor(P, 's2')
  assert.ok(ctx.includes('十块钱'), '私聊应该还记得十块钱')
})

test('群里认识的事只在那一个群可见', () => {
  mem.setProfile('10000001', '爱在群里发猫图', '主人', mem.scopeOfChat(G))
  assert.ok(mem.contextFor(G, 's3').includes('猫图'), '本群能看到本群档案')
  assert.ok(!mem.contextFor(P, 's4').includes('猫图'), '私聊不该看到群里攒的档案')
})

test('global 档案哪里都读得到', () => {
  mem.setProfile('10000001', '他是主人本人', '主人', 'global')
  assert.ok(mem.contextFor(G, 's5').includes('他是主人本人'))
  assert.ok(mem.contextFor(P, 's6').includes('他是主人本人'))
})

test('按作用域查不到别的聊天的档案', () => {
  assert.equal(mem.profileOf('10000001', 'private:999999'), null, '别人的私聊不该读到这份档案')
  assert.ok(mem.profileOf('10000001', 'private:10000001'), '自己的私聊能读到')
})

test('写档案不混入别的作用域的记忆（防私事被提炼成 global）', async () => {
  let seen = ''
  const mem2 = createMemoryStore({
    dsh: { get: () => null }, getConfig: () => cfg,
    hub: { ask: async (_d, o) => { seen = o.text; return '一段档案' }, speakersOf: () => [] },
    log: { info: noop, warn: noop, debug: noop, error: noop },
  })
  // 私聊里三条私事
  for (const t of ['兜里只有十块钱', '猫叫粥粥', '凌晨三点还在熬夜']) {
    mem2.add({ text: t, about: '10000001', importance: 0.8, source: 'tool', chatId: P.chatId, scope: mem2.scopeOfChat(P) })
  }
  // 在陌生群里给同一个人写档案
  const g2 = { chatId: 'group:333444555', kind: 'group', groupId: '333444555' }
  await mem2.buildProfile('10000001', mem2.scopeOfChat(g2))
  assert.ok(!seen.includes('十块钱'), '写群档案时不该看到主人私聊的私事：' + seen)
  assert.ok(!seen.includes('粥粥'), '同上，猫名也不该出现')
})
