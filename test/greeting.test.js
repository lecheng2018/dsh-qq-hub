// 回归：早安/晚安排程（P3-2）。用量遥测部分已随功能移除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { greetingDue } from '../src/features/companion.js'

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
