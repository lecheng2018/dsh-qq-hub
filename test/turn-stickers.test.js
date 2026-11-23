// 同回合表情去重台账（chat/turn-stickers.js）。
// 真机 2026-11-23 15:01：qq_send_sticker 立即直发 + 正文 <sticker:同一张> → 群里两张一样的表情。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnStickers } from '../src/chat/turn-stickers.js'

test('台账：按聊天分别记，新聊天拿到空集（不返回 undefined）', () => {
  const store = createTurnStickers()
  assert.equal(store.sentIn('group:1').size, 0, '没记过也必须是空集，调用方不必判空')
  store.note('group:1', 'm-1')
  assert.ok(store.sentIn('group:1').has('m-1'))
  assert.equal(store.sentIn('group:2').size, 0, '别的聊天不受影响')
})

test('台账：清掉一个聊天不影响别的聊天；不传 chatId 全清', () => {
  const store = createTurnStickers()
  store.note('group:1', 'm-1')
  store.note('group:2', 'm-2')
  store.clear('group:1')
  assert.equal(store.sentIn('group:1').size, 0)
  assert.ok(store.sentIn('group:2').has('m-2'))
  store.clear()
  assert.equal(store.sentIn('group:2').size, 0)
})

test('台账：空 chatId / 空 md5 不入账（不制造幽灵记录）', () => {
  const store = createTurnStickers()
  store.note('', 'm-1')
  store.note('group:1', '')
  assert.equal(store.sentIn('group:1').size, 0)
  assert.equal(store.sentIn('').size, 0)
})

test('台账：同一张重复记只留一份', () => {
  const store = createTurnStickers()
  store.note('group:1', 'm-1')
  store.note('group:1', 'm-1')
  assert.equal(store.sentIn('group:1').size, 1)
})
