// 目的引擎「每日上限」的覆写口径（2026-11-05）：
// 填大于 0 的数才用本模块自己的上限；0、留空（面板存下来是 ''）、未设都沿用「主动搭话」的 maxPerDay。
// 面板侧：数字框允许清空（allowEmpty），空值保存为 '' 而不是被默认值顶回来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { purposeConfig } from '../src/purpose/module.js'

const base = () => ({
  enabled: true,
  ownerQQ: '10000001',
  speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true },
})

const dailyMaxOf = (ext) => purposeConfig({ ...base(), ext: { purpose: { enabled: true, ...ext } } }).dailyMax

test('填了大于 0 的数：用目的引擎自己的每日上限', () => {
  assert.equal(dailyMaxOf({ maxPerDay: 2 }), 2)
  assert.equal(dailyMaxOf({ maxPerDay: 20 }), 20)
  assert.equal(dailyMaxOf({ maxPerDay: 99 }), 20, '超上限夹住')
})

test('0、留空、未设：沿用「主动搭话」的 maxPerDay', () => {
  assert.equal(dailyMaxOf({ maxPerDay: 0 }), 10, '0 = 不启用独立上限')
  assert.equal(dailyMaxOf({ maxPerDay: '' }), 10, '面板清空后存的是空字符串，?? 拦不住，必须显式判空')
  assert.equal(dailyMaxOf({}), 10)
})

test('主动搭话自己没配时退回默认 3', () => {
  const cfg = base()
  cfg.speakUp = { ...cfg.speakUp, maxPerDay: undefined }
  assert.equal(purposeConfig({ ...cfg, ext: { purpose: { enabled: true } } }).dailyMax, 3)
})

test('引擎侧：dailyMax 0 = 不限次（沿用值照常生效，0 才是「今天不发」的引擎语义）', () => {
  // 1.3.48 拆分后这个判定在 engine/state.js（barrel 只 re-export）
  const src = readFileSync(new URL('../src/purpose/engine/state.js', import.meta.url), 'utf8')
  assert.match(src, /config\.dailyMax > 0 && countToday >= config\.dailyMax/, 'dailyMax>0 才拦截')
})

test('面板：数字框支持 allowEmpty，非数字自动过滤', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /allowEmpty/, '数字框要有允许留空的开关')
  assert.match(client, /replace\(\/\[\^\\d\]\//, '非数字内容自动过滤')
  assert.match(client, /s\.key === 'maxPerDay'/, '目的引擎每日上限允许留空')
})

test('设置文案说清新口径', () => {
  const mod = readFileSync(new URL('../src/modules/purpose/index.js', import.meta.url), 'utf8')
  assert.ok(mod.includes('0 或留空 = 沿用「主动搭话」页的次数上限'), 'hint 要写清 0 和留空等价')
  assert.ok(!mod.includes('0 = 今天不发'), '旧口径（0=不发）已经废了')
})
