// 回归：表情别固化（她一天用 130 次系统表情，前 5 个名字占 88%，群里吐槽「怎么老是配 ok」）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeFaces } from '../src/chat/faces.js'

test('同一条回复里同一个表情只留第一次', () => {
  const r = dedupeFaces('好耶 <face:偷笑> 行吧 <face:偷笑>')
  assert.equal(r.text, '好耶 <face:偷笑> 行吧')
  assert.deepEqual(r.used, ['偷笑'])
})

test('和上一条用过的相同 → 这次不夹（换不了就不夹）', () => {
  const r = dedupeFaces('那就这样 <face:OK>', new Set(['OK']))
  assert.equal(r.text, '那就这样')
  assert.deepEqual(r.used, [])
})

test('没撞过就正常保留', () => {
  const r = dedupeFaces('可以 <face:吃瓜>', new Set(['OK']))
  assert.equal(r.text, '可以 <face:吃瓜>')
  assert.deepEqual(r.used, ['吃瓜'])
})

test('不带表情的文本原样返回', () => {
  const r = dedupeFaces('今天天气不错')
  assert.equal(r.text, '今天天气不错')
  assert.deepEqual(r.used, [])
})

test('多个不同表情都保留（只去重，不是一刀切清空）', () => {
  const r = dedupeFaces('哈 <face:偷笑> 嗯 <face:吃瓜>')
  assert.deepEqual(r.used.sort(), ['偷笑', '吃瓜'].sort())
})

test('删掉标签后不留双空格和标点前的空格', () => {
  const r = dedupeFaces('好的 <face:OK> ，知道了', new Set(['OK']))
  assert.equal(r.text, '好的，知道了')
})
