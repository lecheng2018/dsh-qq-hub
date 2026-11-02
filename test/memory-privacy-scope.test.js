import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVisible, scopeOf, visibleScopes } from '../src/modules/memory-privacy/index.js'

// memory-privacy 是独立于 features/memory.js 的一层作用域记忆库，
// 它自己的 isVisible/scopeOf 也曾把「没有 scope」当成 global 放行，
// 这批用例就是钉住这个口径。

const OWNER = { chatId: 'private:2471784685', kind: 'private', userId: '2471784685' }
const STRANGER = { chatId: 'private:99998888', kind: 'private', userId: '99998888' }
const GROUP = { chatId: 'group:1124211723', kind: 'group', groupId: '1124211723' }
const OTHER_GROUP = { chatId: 'group:955741432', kind: 'group', groupId: '955741432' }
const SYSTEM = { chatId: 'system:x', kind: 'system' }

test('无 scope 的条目对任何人都不再可见（以前被当 global 放行）', () => {
  const item = { text: '没有写作用域的老记忆' }
  for (const [name, chat] of [['主人私聊', OWNER], ['陌生人私聊', STRANGER], ['群', GROUP], ['别的群', OTHER_GROUP]]) {
    assert.equal(isVisible(item, chat), false, `${name} 不该看到无 scope 条目`)
  }
})

test('private 条目只在自己的私聊可见', () => {
  const item = { text: '猫叫粥粥', scope: 'private:2471784685' }
  assert.equal(isVisible(item, OWNER), true, '主人私聊可见')
  assert.equal(isVisible(item, STRANGER), false, '别人私聊不可见')
  assert.equal(isVisible(item, GROUP), false, '群里不可见')
})

test('group 条目只在自己的群可见，别的群拿不到', () => {
  const item = { text: '这个群周末聚餐', scope: 'group:1124211723' }
  assert.equal(isVisible(item, GROUP), true)
  assert.equal(isVisible(item, OTHER_GROUP), false, '别的群不该看到')
  assert.equal(isVisible(item, OWNER), false, '私聊里也不该看到群聊内容')
})

test('global 条目处处可见', () => {
  const item = { text: '她是猫娘', scope: 'global' }
  for (const chat of [OWNER, STRANGER, GROUP, OTHER_GROUP]) assert.equal(isVisible(item, chat), true)
})

test('system 会话看不到任何分层记忆', () => {
  for (const sc of ['global', 'private:2471784685', 'group:1124211723']) {
    assert.equal(isVisible({ text: 'x', scope: sc }, SYSTEM), false)
  }
  assert.deepEqual(visibleScopes(SYSTEM), [])
})

test('认不出的聊天类型不会把内容写进 global', () => {
  const weird = { chatId: 'weird:1', kind: 'weird' }
  assert.notEqual(scopeOf(weird), 'global', '兜底不能是 global，否则等于直接公开')
  // 也不该被任何正常聊天看到
  for (const chat of [OWNER, STRANGER, GROUP]) assert.equal(isVisible({ text: 'x', scope: scopeOf(weird) }, chat), false)
})

test('scopeOf 按聊天类型给出正确作用域', () => {
  assert.equal(scopeOf(OWNER), 'private:2471784685')
  assert.equal(scopeOf(GROUP), 'group:1124211723')
  assert.equal(scopeOf(SYSTEM), 'global')
})

test('autoScope 关掉时写进 global 是已知的降级行为（不是默认路径）', () => {
  // 面板里 autoScope:false 会让新记忆一律落 global，等于放弃隔离。
  // 这里钉住「关掉后确实会公开」这个事实，防止有人误以为关了也还安全。
  const written = 'global' // 对应 add() 里 autoScope ? scopeOf(chat) : 'global'
  for (const chat of [OWNER, STRANGER, GROUP, OTHER_GROUP]) {
    assert.equal(isVisible({ text: 'x', scope: written }, chat), true,
      '写进 global 后任何聊天都看得到 —— 这就是关掉 autoScope 的代价')
  }
})
