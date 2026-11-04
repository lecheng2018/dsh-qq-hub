// 回归：用量遥测（P3-1）与早安/晚安排程（P3-2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage, costOf } from '../src/core/telemetry.js'
import { greetingDue } from '../src/features/companion.js'

// ── 遥测 ──────────────────────────────────────────────────────────────────

test('遥测：usage 四个字段归一化，缺字段标 observed=false', () => {
  const u = normalizeUsage({ uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 0 })
  assert.equal(u.total, 170)
  assert.equal(u.observed.input, true)
  const partial = normalizeUsage({ outputTokens: 10 })
  assert.equal(partial.observed.input, false, '缺的字段要标出来，不冒充实测')
  assert.equal(partial.total, 10)
})

test('遥测：没有 usage 记录时全是 0', () => {
  const u = normalizeUsage(null)
  assert.equal(u.total, 0)
  assert.equal(u.observed.output, false)
})

test('遥测：算得出花费的模型给数字', () => {
  const c = costOf({ uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'MiniMax-M3.1-Flash')
  assert.equal(c, 0.15, '100 万输入 token 按 0.15 元/百万')
})

test('遥测：不认识的模型返回 null，不瞎估', () => {
  assert.equal(costOf({ outputTokens: 1000 }, 'some-unknown-model'), null)
})

// ── 早安 / 晚安 ────────────────────────────────────────────────────────────

const cfg = { speakUp: { greeting: { enabled: true, morning: '08:00', night: '23:00' } } }
const at = (h, m) => new Date(2026, 10, 4, h, m).getTime()
const today = new Date(2026, 10, 4).toDateString()

test('问候：到点后一小时内会发，每天只发一次', () => {
  assert.equal(greetingDue(cfg, {}, at(8, 0))?.kind, 'morning')
  assert.equal(greetingDue(cfg, {}, at(8, 30))?.kind, 'morning')
  assert.equal(greetingDue(cfg, { greeted: { morning: today } }, at(8, 30)), null, '今天已发过')
})

test('问候：窗口外不发（太早 / 超一小时后）', () => {
  assert.equal(greetingDue(cfg, {}, at(7, 59)), null)
  assert.equal(greetingDue(cfg, {}, at(9, 5)), null)
})

test('问候：主人 10 分钟内刚说过话就不打扰', () => {
  assert.equal(greetingDue(cfg, {}, at(8, 5), at(8, 2)), null)
})

test('问候：晚安同样到点触发', () => {
  assert.equal(greetingDue(cfg, {}, at(23, 10))?.kind, 'night')
})

test('问候：中间时段不触发', () => {
  assert.equal(greetingDue(cfg, {}, at(12, 0)), null)
})

test('问候：关掉就完全不发', () => {
  const off = { speakUp: { greeting: { enabled: false } } }
  assert.equal(greetingDue(off, {}, at(8, 0)), null)
})
