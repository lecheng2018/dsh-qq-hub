// 回归：身份泄露闸与鱼群保护（移植自 surfcore，MIT）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findIdentityLeaks, checkIdentityLeak, maskLeakValue } from '../src/chat/identity-guard.js'
import { assessFishDensity, isFishName, isFishGroupName, normalizeFishGuard, fishGuardReasonText } from '../src/chat/fish-guard.js'

// ── 身份泄露闸 ────────────────────────────────────────────────────────────

test('身份闸：主人 QQ 号出现在正文里要拦下', () => {
  const r = checkIdentityLeak('主人的号是 10000001，你加他', { ids: ['10000001'] })
  assert.equal(r.ok, false)
  assert.equal(r.hits[0].kind, 'known-id')
  assert.ok(r.message.includes('100****001'), '错误信息里要打码')
})

test('身份闸：「群号 + 数字」形态即使不在名单里也拦', () => {
  const r = checkIdentityLeak('群号 1124211723 你加一下')
  assert.equal(r.ok, false)
  assert.equal(r.hits[0].kind, 'qq-context')
})

test('身份闸：允许的 ID（比如这个群自己的群号）放行', () => {
  const r = checkIdentityLeak('这个群 1124211723 我加了', { allowIds: ['1124211723'] })
  assert.equal(r.ok, true)
})

test('身份闸：裸的 8 位以上数字（群号/QQ 号常见形态）也拦', () => {
  const r = checkIdentityLeak('1124211723 加进白名单了')
  assert.equal(r.ok, false)
  assert.equal(r.hits[0].kind, 'bare-number')
})

test('身份闸：5~7 位数量数字不误伤（评论数/播放量）', () => {
  for (const t of ['今天的帖子有 12345 条评论', '播放量 1234567'])
    assert.equal(checkIdentityLeak(t).ok, true, `不该拦：${t}`)
})

test('身份闸：普通数字（年份/播放量/BV号）不误伤', () => {
  for (const t of ['400 万播放，2026 年发售', 'BV1xx411c7mD 这个视频', '268 元的定价', '今年 11 月 12 日更新']) {
    assert.equal(checkIdentityLeak(t, { ids: ['10000001'] }).ok, true, `不该拦：${t}`)
  }
})

test('身份闸：warn 模式只告警不拦', () => {
  const r = checkIdentityLeak('主人的号 10000001', { ids: ['10000001'], mode: 'warn' })
  assert.equal(r.ok, true)
  assert.ok(r.hits.length)
})

test('身份闸：打码保留首尾', () => {
  assert.equal(maskLeakValue('10000001'), '100****001')
  assert.equal(maskLeakValue('12345'), '1****5')
})

// ── 鱼群保护 ──────────────────────────────────────────────────────────────

const guard = normalizeFishGuard({ nameContains: ['肥鱼', '鲸', '鱼'] })
const mk = (sender, t, extra = {}) => ({ sender, userId: `u${sender}`, time: t, ...extra })

test('鱼群：认出同类 bot 名字，不误伤真人', () => {
  for (const n of ['无敌大肥鱼', '小鲸', '泡泡/鲸生（超级大灵珠）', '蓝色大肥鱼（测试用鱼）', '咸鱼']) {
    assert.equal(isFishName(n, guard), true, `${n} 应该算鱼`)
  }
  for (const n of ['饭包', '沈汐', '雫']) {
    assert.equal(isFishName(n, guard), false, `${n} 不该算鱼`)
  }
  // 「全鱼公敌」是真人，名字带「鱼」会被规则误判 —— 用 exemptNames 豁免
  const guarded = normalizeFishGuard({ nameContains: ['肥鱼', '鲸', '鱼'], exemptNames: ['全鱼公敌'] })
  assert.equal(isFishName('全鱼公敌', guarded), false, 'exemptNames 要能豁免名字带鱼字的真人')
})

test('鱼群：名字带尾号/装饰仍能认出', () => {
  assert.equal(isFishName('无敌大肥鱼2', guard), true)
  assert.equal(isFishName('无敌大肥鱼_2', guard), true)
  assert.equal(isFishName('肥鱼✨', guard), true)
})

test('鱼群：不同鱼 ≥ 阈值 → 拦', () => {
  const now = 1000000
  const msgs = [
    mk('无敌大肥鱼', now - 1000), mk('小鲸', now - 2000), mk('泡泡鲸生', now - 3000),
    mk('蓝色肥鱼', now - 4000), mk('咸鱼', now - 5000), mk('饭包', now - 6000),
  ]
  const a = assessFishDensity(msgs, { now, guard })
  assert.equal(a.blocked, true)
  assert.equal(a.reason, 'fish-count')
  assert.equal(a.fishCount, 5)
})

test('鱼群：连续全是鱼（≥2 只）→ 拦', () => {
  const now = 1000000
  const msgs = [mk('饭包', now - 9000), ...Array.from({ length: 5 }, (_, i) => mk(i % 2 ? '小鲸' : '无敌大肥鱼', now - 4000 + i * 500))]
  const a = assessFishDensity(msgs, { now, guard })
  assert.equal(a.blocked, true)
  assert.ok(['fish-streak', 'fish-streak-single'].includes(a.reason))
})

test('鱼群：正常聊天（鱼少）不拦', () => {
  const now = 1000000
  const msgs = [mk('饭包', now - 1000), mk('沈汐', now - 2000), mk('无敌大肥鱼', now - 3000), mk('雫', now - 4000)]
  assert.equal(assessFishDensity(msgs, { now, guard }).blocked, false)
})

test('鱼群：群名像鱼窝时阈值收紧到 3', () => {
  const now = 1000000
  const msgs = [mk('无敌大肥鱼', now - 1000), mk('小鲸', now - 2000), mk('泡泡鲸生', now - 3000), mk('饭包', now - 4000)]
  assert.equal(assessFishDensity(msgs, { now, guard, groupName: '日常闲聊' }).blocked, false)
  assert.equal(assessFishDensity(msgs, { now, guard, groupName: '摸鱼肥鱼窝' }).blocked, true, '鱼窝群放宽到 3 只就拦')
})

test('鱼群：关掉就不拦', () => {
  const now = 1000000
  const msgs = Array.from({ length: 10 }, (_, i) => mk('无敌大肥鱼', now - i * 100))
  assert.equal(assessFishDensity(msgs, { now, guard: normalizeFishGuard({ enabled: false }) }).blocked, false)
})

test('鱼群：人话原因能说清为什么拦', () => {
  const now = 1000000
  const msgs = [
    mk('无敌大肥鱼', now - 1000), mk('小鲸', now - 2000), mk('泡泡鲸生', now - 3000),
    mk('蓝色肥鱼', now - 4000), mk('咸鱼', now - 5000),
  ]
  const a = assessFishDensity(msgs, { now, guard })
  assert.ok(fishGuardReasonText(a).includes('条不同的鱼'))
})

test('鱼群：群名判定用包含（摸鱼后援会也算鱼窝）', () => {
  assert.equal(isFishGroupName('摸鱼肥鱼窝', guard), true)
  assert.equal(isFishGroupName('日常闲聊', guard), false)
})
