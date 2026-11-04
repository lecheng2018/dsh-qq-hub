// 回归：长句硬拆不能切断标签、不能以逗号结尾（2026-11-04 线上两个真实 bug）。
//
// bug 1: "<face:捂脸>" 被拆成 "<face:" + "捂脸>" —— 用户收到两条残缺消息
// bug 2: 拆出来的上一条以「，」结尾 —— 读起来像半句话，没有活人感
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const textsOf = (s) => parseReply(s).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('硬拆不能切断 <face:…> 标签（线上 bug）', () => {
  const out = textsOf('那我就闷锅里煮着，什么时候开盖什么时候算我熟 <face:捂脸>')
  const joined = out.join('')
  assert.ok(joined.includes('<face:捂脸>'), '标签必须完整：' + JSON.stringify(out))
  assert.equal(out.some((t) => t.endsWith('<face:')), false, '不能出现半截标签')
  assert.equal(out.some((t) => t.startsWith('捂脸>')), false, '不能出现半截标签尾巴')
})

test('硬拆不会把 <sticker:…> 标签切坏（它会被正确提取成表情 item）', () => {
  const items = parseReply('你这话说得我有点想笑 <sticker:无语> 但是又觉得有道理').items
  const sticker = items.find((i) => i.kind === 'sticker')
  assert.ok(sticker, '表情标签应该被提取成 sticker item：' + JSON.stringify(items))
  assert.equal(sticker.value, '无语', '表情值不能残缺')
  // 文本里也不能残留半截标签
  for (const t of items.filter((i) => i.kind === 'text')) {
    assert.equal(/<sticker:|<face:|^\S+>/.test(t.value), false, '文本里有半截标签：' + JSON.stringify(t.value))
  }
})

test('拆出来的每一条都不能以逗号/顿号/冒号结尾（线上 bug）', () => {
  const out = textsOf('今天我去了那个新开的商场，里面人特别多而且到处都在排队，还碰到大学同学了，他说最近换了工作')
  assert.ok(out.length >= 2, '这么长应该拆开')
  for (const t of out) {
    assert.equal(/[，,、：:；;]$/.test(t), false, '这条以逗号结尾了：' + JSON.stringify(t))
  }
})

test('短句原样通过，不该乱切', () => {
  assert.deepEqual(textsOf('草'), ['草'])
  assert.deepEqual(textsOf('不告诉你'), ['不告诉你'])
})

test('硬拆后的每一条都不超 30 字（除非单句本身超长）', () => {
  const out = textsOf('今天我去了那个新开的商场，里面人特别多而且到处都在排队，还碰到大学同学了')
  for (const t of out) {
    assert.ok(t.length <= 30, '这条超了 30 字：' + t.length + ' ' + JSON.stringify(t))
  }
})
