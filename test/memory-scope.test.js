import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// memory.js 用 dataDir() 决定落盘位置，先指到一个临时目录再动态 import
const dir = mkdtempSync(join(tmpdir(), 'ab-scope-'))
mkdirSync(join(dir, 'aurabot'), { recursive: true })
process.env.AURABOT_DATA_DIR = dir
process.env.DSH_PLUGIN_DATA = dir

const { createMemoryStore } = await import('../src/features/memory.js')

const cfg = {
  botQQ: '10001', ownerQQ: '10001', ownerName: '主人',
  memory: { enabled: true, recallCount: 8, dailyHour: 23, keepDays: 30, autoExtract: true },
}
const noop = () => {}
const store = createMemoryStore({
  dsh: { get: () => null },
  getConfig: () => cfg,
  hub: { ask: noop },
  log: { info: noop, warn: noop, debug: noop, error: noop },
})

const PRIVATE = { chatId: 'private:20002', kind: 'private', userId: '20002' }
const GROUP   = { chatId: 'group:30003',  kind: 'group',   groupId: '30003' }
const OTHER   = { chatId: 'private:40004', kind: 'private', userId: '40004' }

test('scopeOfChat：私聊/群/系统各自的作用域', () => {
  assert.equal(store.scopeOfChat(PRIVATE), 'private:20002')
  assert.equal(store.scopeOfChat(GROUP), 'group:30003')
  assert.equal(store.scopeOfChat({ kind: 'system' }), 'global')
  assert.equal(store.scopeOfChat(null), 'global')
})

test('scopeVisible：私聊记忆在群里不可见，在别的私聊也不可见', () => {
  assert.equal(store.scopeVisible('private:20002', PRIVATE), true)
  assert.equal(store.scopeVisible('private:20002', GROUP), false, '私聊记忆不该在群里可见')
  assert.equal(store.scopeVisible('private:20002', OTHER), false, '私聊记忆不该在别人私聊可见')
  assert.equal(store.scopeVisible('global', GROUP), true, 'global 哪里都可见')
  assert.equal(store.scopeVisible(undefined, GROUP), true, '老数据没 scope 当 global')
})

test('端到端：私聊记住猫名，群里检索不到、私聊能检索到', () => {
  store.add({ text: '主人的猫叫粥粥', about: '20002', aboutName: '主人', importance: 0.9,
              source: 'tool', chatId: PRIVATE.chatId, scope: store.scopeOfChat(PRIVATE) })

  // 私聊：能想起来
  const inPrivate = store.recall('猫叫什么', { about: '20002', chat: PRIVATE })
  assert.ok(inPrivate.some((h) => h.it.text.includes('粥粥')), '私聊应该能想起粥粥')

  // 群聊：必须检索不到（这是记忆隔离的核心）
  const inGroup = store.recall('猫叫什么', { chat: GROUP })
  assert.ok(!inGroup.some((h) => h.it.text.includes('粥粥')), '群里不该检索到私聊的记忆')

  // 别的私聊：也检索不到
  const inOther = store.recall('猫叫什么', { chat: OTHER })
  assert.ok(!inOther.some((h) => h.it.text.includes('粥粥')), '别人的私聊不该检索到')
})

test('recallHint 也走作用域（模型拿不到群里被过滤的内容）', () => {
  const hintPrivate = store.recallHint(PRIVATE, '猫叫什么', '')
  const hintGroup = store.recallHint(GROUP, '猫叫什么', '')
  assert.ok(hintPrivate.includes('粥粥'), '私聊提示词里应该有粥粥')
  assert.ok(!hintGroup.includes('粥粥'), '群聊提示词里绝不能出现粥粥')
})

test('群里记的事不会漏到私聊', () => {
  store.add({ text: '这个群周末要聚餐', about: '', importance: 0.7,
              source: 'tool', chatId: GROUP.chatId, scope: store.scopeOfChat(GROUP) })
  assert.ok(store.recall('聚餐', { chat: GROUP }).some((h) => h.it.text.includes('聚餐')), '群里能想起')
  assert.ok(!store.recall('聚餐', { chat: PRIVATE }).some((h) => h.it.text.includes('聚餐')), '私聊不该想起群里的')
})

test('global 记忆哪里都能用', () => {
  store.add({ text: '我叫大肥鱼', importance: 0.9, source: 'tool', scope: 'global' })
  assert.ok(store.recall('大肥鱼', { chat: GROUP }).length > 0, '群里能想起 global')
  assert.ok(store.recall('大肥鱼', { chat: PRIVATE }).length > 0, '私聊能想起 global')
})
