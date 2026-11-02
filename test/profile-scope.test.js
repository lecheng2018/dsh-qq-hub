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
const cfg = { botQQ: '3457241415', ownerQQ: '444555666', ownerName: '主人',
  memory: { enabled: true, recallCount: 8, dailyHour: 23, keepDays: 30, autoExtract: true } }
const mem = createMemoryStore({
  dsh: { get: () => null }, getConfig: () => cfg,
  hub: { ask: noop, speakersOf: () => ['444555666'] },
  log: { info: noop, warn: noop, debug: noop, error: noop },
})

const G = { chatId: 'group:222333444', kind: 'group', groupId: '222333444' }
const P = { chatId: 'private:444555666', kind: 'private', userId: '444555666' }

test('私聊攒的档案不出现在群聊上下文里', () => {
  mem.setProfile('444555666', '兜里只有十块钱，猫叫粥粥', '主人', mem.scopeOfChat(P))
  const ctx = mem.contextFor(G, 's1')
  assert.ok(!ctx.includes('十块钱'), '群聊上下文里不该出现私聊的十块钱')
  assert.ok(!ctx.includes('粥粥'), '群聊上下文里不该出现私聊的猫名')
})

test('私聊自己的档案照常读取', () => {
  const ctx = mem.contextFor(P, 's2')
  assert.ok(ctx.includes('十块钱'), '私聊应该还记得十块钱')
})

test('群里认识的事只在那一个群可见', () => {
  mem.setProfile('444555666', '爱在群里发猫图', '主人', mem.scopeOfChat(G))
  assert.ok(mem.contextFor(G, 's3').includes('猫图'), '本群能看到本群档案')
  assert.ok(!mem.contextFor(P, 's4').includes('猫图'), '私聊不该看到群里攒的档案')
})

test('global 档案哪里都读得到', () => {
  mem.setProfile('444555666', '他是主人本人', '主人', 'global')
  assert.ok(mem.contextFor(G, 's5').includes('他是主人本人'))
  assert.ok(mem.contextFor(P, 's6').includes('他是主人本人'))
})

test('按作用域查不到别的聊天的档案', () => {
  assert.equal(mem.profileOf('444555666', 'private:999999'), null, '别人的私聊不该读到这份档案')
  assert.ok(mem.profileOf('444555666', 'private:444555666'), '自己的私聊能读到')
})
