// 回归：群里不许报出主人是谁（2026-11-04 主人反馈：别人一问，她直接把主人的号说出来）。
//
// 三道门：
//   1. 群聊规则里不写主人 QQ 号，且带「身份保密」条款；
//   2. 主人在群里发言时标注成「主人」，不带号码；
//   3. 出站前身份闸再兜一层（identity-guard）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rulesText } from '../src/persona/personas.js'

const OWNER = '10000001'
const cfg = { ownerQQ: OWNER, ownerName: '主人', stickers: {}, imageGen: {}, bili: {}, song: {} }

test('群聊规则绝不包含主人 QQ 号', () => {
  const social = rulesText('social', cfg)
  assert.equal(social.includes(OWNER), false, '群聊提示词里出现主人号码 = 一问就会报')
})

test('主人私聊规则仍然包含号码（私聊本来只有主人）', () => {
  const priv = rulesText('private', cfg)
  assert.equal(priv.includes(OWNER), true, '私聊要能认主人')
})

test('群聊规则带身份保密条款：谁问都不说', () => {
  const social = rulesText('social', cfg)
  assert.ok(social.includes('【身份保密】'), '缺保密条款')
  assert.ok(social.includes('你主人是谁'), '条款要明确覆盖这个问法')
  assert.ok(social.includes('不报任何 QQ 号或群号'), '条款要禁止报号码')
})

test('群聊规则要防冒充：对方自称主人也不认', () => {
  const social = rulesText('social', cfg)
  assert.ok(social.includes('我是你主人'), '要写明自称主人不算')
})

test('群聊来源说明只描述「有一个人是主人」，不给具体信息', () => {
  const social = rulesText('social', cfg)
  assert.ok(social.includes('不知道也不该说出他的 QQ 号'), '来源说明也要堵住')
})
