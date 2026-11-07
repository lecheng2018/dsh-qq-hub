// 回归：内容解析的群/私聊分流（主人要求：有时候不希望给群提供这个功能）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedHere } from '../src/modules/multi-parser/index.js'

const group = (gid) => ({ kind: 'group', groupId: gid, chatId: `group:${gid}` })
const priv = (uid) => ({ kind: 'private', userId: uid, chatId: `private:${uid}` })

test('默认全开：群和私聊都解析', () => {
  assert.equal(allowedHere(group('1124211723'), {}), true)
  assert.equal(allowedHere(priv('10000001'), {}), true)
})

test('关掉群：群里不解析，私聊照旧', () => {
  assert.equal(allowedHere(group('1124211723'), { inGroups: false }), false)
  assert.equal(allowedHere(priv('10000001'), { inGroups: false }), true)
})

test('关掉私聊：私聊不解析，群照旧', () => {
  assert.equal(allowedHere(priv('1'), { inPrivate: false }), false)
  assert.equal(allowedHere(group('1124211723'), { inPrivate: false }), true)
})

test('单个群拉黑：只影响那个群', () => {
  const c = { disabledGroups: ['615693464'] }
  assert.equal(allowedHere(group('615693464'), c), false)
  assert.equal(allowedHere(group('1124211723'), c), true)
})

test('群拉黑与总开关同时开着也拦得住', () => {
  assert.equal(allowedHere(group('615693464'), { inGroups: true, disabledGroups: ['615693464'] }), false)
})

test('system 后台轮次不解析', () => {
  assert.equal(allowedHere({ kind: 'system', chatId: 'system:heybox' }, {}), false)
})

test('chatId 兜底：只给 chatId 也能认出群号', () => {
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:615693464' }, { disabledGroups: ['615693464'] }), false)
})
