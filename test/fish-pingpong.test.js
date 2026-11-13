// 乒乓对聊拦截 + 鱼叫人不豁免（2026-11-06 实测事故回归）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assessFishDensity, senderFish, normalizeFishGuard, fishGuardReasonText, assessPairLoop } from '../src/chat/fish-guard.js'

const now = Date.now()
const FISH = { userId: '555666777', sender: '某bot', isSelf: false }
const ME = { userId: '444555666', sender: '大肥鱼（我）', isSelf: true }
const HUMAN = { userId: '555', sender: '张三', isSelf: false }
const guard = () => normalizeFishGuard({ fishIds: ['555666777'] })

test('senderFish：鱼名单 uid 命中，哪怕名字完全不像鱼', () => {
  assert.equal(senderFish(FISH, guard()), true)
  assert.equal(senderFish(HUMAN, guard()), false)
  assert.equal(senderFish(ME, guard()), false, '自己不参与')
})

test('乒乓规则⑥：我↔同一只鱼交替 8 条即拦截（名字不像鱼也拦，纯行为）', () => {
  const msgs = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ ...FISH, time: now - (4 - i) * 30000 })
    msgs.push({ ...ME, time: now - (4 - i) * 30000 + 15000 })
  }
  const r = assessFishDensity(msgs, { now, guard: guard() })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'ping-pong')
  assert.equal(r.pingPong, 8)
  assert.match(fishGuardReasonText(r), /交替对聊 8 条/)
})

test('乒乓阈值以下放行；真人穿插/两侧同连发都不算乒乓', () => {
  const three = []
  for (let i = 0; i < 3; i++) { three.push({ ...FISH, time: now - i * 20000 }, { ...ME, time: now - i * 20000 + 10000 }) }
  assert.equal(assessFishDensity(three, { now, guard: guard() }).reason !== 'ping-pong', true, '6 条不到 8，不拦')
  const mixed = [{ ...FISH, time: now - 4000 }, { ...ME, time: now - 3000 }, { ...HUMAN, time: now - 2000 }]
  assert.equal(assessFishDensity(mixed, { now, guard: guard() }).pingPong <= 2, true, '真人出现后链条断')
  const burst = [{ ...ME, time: now - 3000 }, { ...ME, time: now - 2000 }, { ...FISH, time: now - 1000 }, { ...ME, time: now - 500 }]
  assert.equal(assessFishDensity(burst, { now, guard: guard() }).pingPong, 3, '自侧连发即断链，计数从尾部算 3')
})

test('当前核心的「被叫到」豁免先看叫人的是不是鱼', () => {
  const core = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')
  assert.match(core, /senderFish[^}]*\} from '\.\.\/chat\/fish-guard\.js'/)
  assert.match(core, /const callerIsFish = senderFish\(\{ userId, sender: inbound\.sender\?\.nickname \}, fg\)/)
  assert.match(core, /direct && fg\.bypassDirectAddress && !callerIsFish/, '鱼叫人 → 豁免失效')
})

test('pair 预算：名单里的鱼 2 个来回即停，陌生人 4 个来回才停，真人插话清零', () => {
  const me = { isSelf: true, userId: '1' }
  const f = (id) => ({ isSelf: false, userId: id })
  const g = { fishIds: ['555666777'] }
  const fishG = { fishIds: ['8801234567'] }
  const twoRounds = [me, f('8801234567'), me, f('8801234567')]
  const p1 = assessPairLoop(twoRounds, '8801234567', { guard: fishG })
  assert.equal(p1.isFish, true)
  assert.equal(p1.rounds, 2)
  assert.equal(p1.blocked, true, '确认的鱼第二回合就掐')
  const p2 = assessPairLoop(twoRounds, '8801234567', { guard: g })
  assert.equal(p2.blocked, false, '陌生人两回合不动')
  const p3 = assessPairLoop([me, f('5'), me, f('5'), me, f('5'), me, f('5')], '5', { guard: g })
  assert.equal(p3.blocked, true, '陌生人 4 回合停')
  const p4 = assessPairLoop([me, f('5'), { isSelf: false, userId: '9' }, me, f('5')], '5', { guard: g })
  assert.equal(p4.blocked, false, '真人插一句就重置')
})

test('当前核心用 pair 预算 + pair 冷却，主人豁免在 pair 检查前', () => {
  const core = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')
  assert.match(core, /assessPairLoop\(pairMsgs, userId, \{ guard: fg \}\)/)
  assert.match(core, /userId !== String\(getConfig\(\)\.ownerQQ/, '主人完全不进 pair 判定')
  assert.match(core, /const calmUntil = pairCalmUntil\.get\(pairKey\) \|\| 0[\s\S]{0,80}if \(calmUntil > now\)/, '冷却期内直接不回（含 @）')
  assert.match(core, /pairCalmUntil\.set\(pairKey, now \+ fg\.pairCooldownMs\)/)
})
