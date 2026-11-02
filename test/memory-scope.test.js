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
  // 这一条以前断言 true（「老数据没 scope 当 global」），正是跨群泄漏的主因：
  // 无 scope 的老数据如果一律放行，任何陌生群都能查到历史上所有私聊记忆。
  assert.equal(store.scopeVisible(undefined, GROUP), false, '老数据没 scope：不当 global 放行，宁可少给')
  assert.equal(store.scopeVisible('', PRIVATE), false, '空 scope 同样不跨聊天可见')
  assert.equal(store.scopeVisible('   ', GROUP), false, '空白 scope 也算没有作用域')
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

// ---------- 回归：之前漏掉的泄漏路径（addEvent / contextFor / recentEvents） ----------
// 这一组对应真实事故：陌生群 333444555 问出「主人平时几点睡」「主人有什么喜好」。
// 以前的 recall() 会按 chat 过滤，但 addEvent 落库时没传 scope（写成 global），
// contextFor / recallHint 里的 recentEvents() 又不带 chat 过滤，于是从另一条路漏了出去。

test('addEvent 不再把经历写成 global：传了 chat 就落到那个聊天', () => {
  store.addEvent({ text: '在私聊里给主人发了张猫图', about: '20002', tags: ['画画'], importance: 0.5, chat: PRIVATE })
  const row = store.list().find((m) => m.text.includes('猫图'))
  assert.ok(row, '经历应该写进去了')
  assert.equal(row.scope, 'private:20002', '带 chat 的经历必须落到那个私聊，不能是 global')
})

test('私聊里的经历不会出现在陌生群的上下文里（contextFor）', () => {
  store.addEvent({ text: '给主人唱了《稻香》', about: '20002', tags: ['唱歌'], importance: 0.5, chat: PRIVATE })
  const inGroup = store.contextFor({ chatId: 'group:99999', kind: 'group', groupId: '99999' }, 's-leak-1')
  assert.ok(!inGroup.includes('稻香'), '陌生群的上下文里绝不能出现私聊的经历：' + inGroup)
  const inPrivate = store.contextFor(PRIVATE, 's-leak-2')
  assert.ok(inPrivate.includes('稻香'), '本人在私聊里应该想得起这件事：' + inPrivate)
})

test('私聊里的经历不会出现在陌生群的 recallHint 里', () => {
  const hint = store.recallHint({ chatId: 'group:99999', kind: 'group', groupId: '99999' }, '你最近做了什么', '')
  assert.ok(!hint.includes('稻香'), '陌生群提示词里不该有：' + hint)
})

test('recentEvents 带 chat 时按作用域过滤，不带时保持老行为', () => {
  const strangerRecent = store.recentEvents(24, 20, { chatId: 'group:99999', kind: 'group', groupId: '99999' })
  assert.ok(!strangerRecent.some((m) => m.text.includes('稻香')), '陌生群看不到私聊经历')
  const ownRecent = store.recentEvents(24, 20, PRIVATE)
  assert.ok(ownRecent.some((m) => m.text.includes('稻香')), '本人私聊能看得到')
  // 老调用（不传 chat）不过滤，保持向后兼容
  assert.ok(store.recentEvents(24, 20).some((m) => m.text.includes('稻香')), '不传 chat 时保持老行为')
})

test('全局经历（她自己做过的事）谁都能提到', () => {
  store.addEvent({ text: '她在B站看了《测试视频》', tags: ['B站'], importance: 0.4, scope: 'global' })
  const strangerRecent = store.recentEvents(24, 20, { chatId: 'group:99999', kind: 'group', groupId: '99999' })
  assert.ok(strangerRecent.some((m) => m.text.includes('测试视频')), 'global 经历应该进得了陌生群上下文')
})
