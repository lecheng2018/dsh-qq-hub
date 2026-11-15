// 社交动作模块（social-actions/）的回归网：回应决策是安全核心，逐条打。
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideReaction, conflictPresentIn, REACTION_COOLDOWN_MS } from '../src/modules/social-actions/index.js'
import { mineSignals } from '../src/chat/affective-signals.js'

// ---------------------------------------------------------------------------
// decideReaction：温度门槛 / 冲突压制 / 概率 / 冷却
// ---------------------------------------------------------------------------

test('温度 <1（陌生人）绝不回应', () => {
  for (const level of [0, undefined, null, NaN]) {
    assert.equal(decideReaction({ level, conflictPresent: false, chance: 1, cooldownActive: false, pool: ['4'] }), null, `level=${level} 不回应`)
  }
})

test('冲突/越界在场绝不回应（哪怕温度 2、概率 100%）', () => {
  const r = decideReaction({ level: 2, conflictPresent: true, chance: 1, cooldownActive: false, pool: ['4'] })
  assert.equal(r, null, '吵架时补表情 = 火上浇油，必须挡住')
})

test('空表情池 / 冷却中不回应', () => {
  assert.equal(decideReaction({ level: 2, conflictPresent: false, chance: 1, cooldownActive: false, pool: [] }), null)
  assert.equal(decideReaction({ level: 2, conflictPresent: false, chance: 1, cooldownActive: true, pool: ['4'] }), null)
})

test('概率判定走注入的随机源（0 概率绝不回、1 概率必回）', () => {
  const zero = decideReaction({ level: 2, conflictPresent: false, chance: 0, random: () => 0.01, cooldownActive: false, pool: ['4'] })
  assert.equal(zero, null)
  const one = decideReaction({ level: 2, conflictPresent: false, chance: 1, random: () => 0.5, cooldownActive: false, pool: ['4'] })
  assert.equal(one, '4')
})

test('命中时从表情池里取（池子只有一个元素就必须是它）', () => {
  for (let i = 0; i < 5; i++) {
    const r = decideReaction({ level: 1, conflictPresent: false, chance: 1, random: Math.random, cooldownActive: false, pool: ['85'] })
    assert.equal(r, '85')
  }
})

test('冷却常量：30 分钟（防刷屏的底线）', () => {
  assert.equal(REACTION_COOLDOWN_MS, 30 * 60_000)
})

// ---------------------------------------------------------------------------
// conflictPresentIn：复用 affective-signals 的保守判定
// ---------------------------------------------------------------------------

test('冲突文本判定为在场（「你有病」「滚」）', () => {
  assert.equal(conflictPresentIn('你有病吧，滚开', mineSignals), true)
})

test('普通聊天判定为不在场', () => {
  assert.equal(conflictPresentIn('今天天气不错，出来玩吗', mineSignals), false)
})

test('判定器坏了按「在场」处理（宁可漏回应，不可火上浇油）', () => {
  const broken = () => { throw new Error('boom') }
  assert.equal(conflictPresentIn('随便什么', broken), true)
})
