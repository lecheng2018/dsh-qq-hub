// Batch 3 · T3.9：配置归一化 / B 站清空复活 / 可选 validate / 异步 setup 卸载竞态 / 依赖解析
//
// 全部真实调用导出函数或真实装配 modules.js + store.js 观察行为，不做源码正则断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeFromPanel, normalize } from '../src/core/config-normalizers.js'
import { readJsonWithBackup } from '../src/core/store.js'
import { createModules, API_VERSION } from '../src/core/modules.js'
import { planModules } from '../src/core/module-sdk.js'

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log }

const withCookie = normalize({
  bili: {
    sessdata: 'SESS-OLD',
    biliJct: 'JCT-OLD',
    cookie: 'SESSDATA=SESS-OLD; bili_jct=JCT-OLD',
    enabled: true,
  },
})

test('T3.9 面板清空 B 站凭证：旧 cookie 不得从 .bak 式的字段反解复活', () => {
  const next = mergeFromPanel(withCookie, { bili: { sessdata: null, biliJct: null } })
  assert.equal(next.bili.sessdata, '', '显式 null = 清空')
  assert.equal(next.bili.biliJct, '', '显式 null = 清空')
  assert.equal(next.bili.cookie, '', 'splitBiliCookie 不许从旧 cookie 里把两个字段反解回来')
})

test('T3.9 面板只改一个 B 站字段：另一个保留，合并 cookie 失效', () => {
  const next = mergeFromPanel(withCookie, { bili: { sessdata: 'SESS-NEW' } })
  assert.equal(next.bili.sessdata, 'SESS-NEW')
  assert.equal(next.bili.biliJct, 'JCT-OLD', '没改的字段保留')
  assert.equal(next.bili.cookie, 'SESSDATA=SESS-NEW; bili_jct=JCT-OLD', '重新按新值拼接')
})

test('T3.9 hhmm 校验真实时钟范围：25:90 / 99:99 回落到默认值', () => {
  const cfg = normalize({ diary: { windowStart: '25:90', windowEnd: '99:99' } })
  assert.equal(cfg.diary.windowStart, '10:00')
  assert.equal(cfg.diary.windowEnd, '23:30')
  const ok = normalize({ diary: { windowStart: '00:00', windowEnd: '23:59' } })
  assert.equal(ok.diary.windowStart, '00:00', '边界值必须保留')
  assert.equal(ok.diary.windowEnd, '23:59')
  const times = normalize({ memory: { consolidateTimes: ['24:00', '04:00'] } })
  assert.deepEqual(times.memory.consolidateTimes, ['04:00'], '非法整理时刻被剔除')
})

test('T3.9 speakUp / heybox 归一化补全：字符串开关不当真、越界小时被钳制', () => {
  const cfg = normalize({
    speakUp: {
      enabled: 'false', awakeFrom: '25', awakeTo: '-3',
      greeting: { enabled: 'yes', morning: '7:99', night: '22:30' },
    },
    heybox: {
      enabled: 'false', perRun: '3', maxPostsPerDay: 99, defaultTopic: 'abc',
      postStyle: 'unknown', cookie: '   ',
    },
  })
  assert.equal(cfg.speakUp.enabled, true, '字符串不是布尔值 → 用默认值（true），不是被 "false" 骗成关')
  assert.equal(cfg.speakUp.awakeFrom, 23, '越界小时钳到 23')
  assert.equal(cfg.speakUp.awakeTo, 0, '负小时钳到 0')
  assert.equal(cfg.speakUp.greeting.enabled, true)
  assert.equal(cfg.speakUp.greeting.morning, '08:00', '假时间回落默认')
  assert.equal(cfg.speakUp.greeting.night, '22:30')
  assert.equal(cfg.heybox.enabled, false, 'heybox 默认关')
  assert.equal(cfg.heybox.perRun, 3, '数字字符串归一为数字')
  assert.equal(cfg.heybox.maxPostsPerDay, 10, '越界钳到硬上限 10（不会被限流封号）')
  assert.equal(cfg.heybox.defaultTopic, 7214, '非数字 Topic 回落默认分区')
  assert.equal(cfg.heybox.postStyle, 'mix')
  assert.equal(cfg.heybox.cookie, '')
})

test('T3.9 store.readJsonWithBackup 不传 validate 也能正常读取（不再误隔离）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-store-'))
  const file = join(dir, 'state.json')
  try {
    writeFileSync(file, JSON.stringify({ ok: 1, items: [1, 2] }))
    const got = readJsonWithBackup(file)
    assert.deepEqual(got.value, { ok: 1, items: [1, 2] })
    assert.equal(got.error, null)
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.corrupt-')), [], '正常文件不许被隔离')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T3.9 store.readJsonWithBackup 传了 validate 仍然拦截结构不符的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-store-v-'))
  const file = join(dir, 'state.json')
  try {
    writeFileSync(file, JSON.stringify({ ok: 1 }))
    const got = readJsonWithBackup(file, { validate: (v) => Array.isArray(v.items), fallback: () => ({ fallback: true }) })
    assert.deepEqual(got.value, { fallback: true })
    assert.ok(readdirSync(dir).some((n) => n.includes('.corrupt-')), '结构不符要留证据')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T3.9 异步 setup 期间 stop：恢复后不许残留定时器/路由，health 保持 disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-mod-'))
  const modDir = join(dir, 'modules', 'slow')
  process.env.AURABOT_DATA_DIR = dir
  const probe = globalThis.__b3mod = { started: false, done: false, timers: [], routes: [], error: null }
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'index.mjs'), `
const probe = globalThis.__b3mod
export default {
  id: 'slow', name: '慢模块', version: '1.0.0', api: 1,
  async setup(api) {
    probe.started = true
    await new Promise((resolve) => { probe.release = resolve })
    try {
      api.every(60000, () => {})
      probe.timers.push('every')
      api.route('/slow', () => ({}))
      probe.routes.push('route')
    } catch (error) {
      probe.error = error
    }
    probe.done = true
    return { dispose() {} }
  },
}
`, 'utf8')
  try {
    const mods = createModules({
      ctx: { effect: (fn) => { const off = fn?.(); return () => { try { off?.() } catch {} } }, get: () => null },
      core: { hub: {}, bridge: { refresh() {} } },
      getConfig: () => ({ modules: { slow: { enabled: true } }, safeMode: false }),
      setConfig: () => {},
      logger: log,
      version: 'test',
      builtins: [],
    })
    mods.boot()
    for (let i = 0; i < 200 && !probe.started; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(probe.started, true, '异步 setup 应真的跑起来')
    assert.equal(mods.stop('slow'), true)
    assert.equal(mods.health().slow.state, 'disabled')
    probe.release()
    for (let i = 0; i < 200 && !probe.done; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(probe.done, true)
    assert.ok(probe.error, 'stop 之后再注册必须被拒绝（不是静默成功）')
    assert.match(probe.error.message, /已停止/)
    assert.deepEqual(probe.timers, [], '不得残留定时器')
    assert.deepEqual(probe.routes, [], '不得残留路由')
    assert.equal(mods.hasRoute('/qq-hub/api/ext/slow/slow'), false)
    assert.equal(mods.health().slow.state, 'disabled', '旧实例 setup 报错不许把 health 改成 failed')
    mods.dispose()
  } finally {
    delete process.env.AURABOT_DATA_DIR
    delete globalThis.__b3mod
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T3.9 planModules：依赖方声明在提供方之前也能装载（迭代到不动点）', () => {
  const def = (over) => ({ id: 'm', version: '1.0.0', setup: () => ({}), ...over })
  const plan = planModules({
    defs: [
      def({ id: 'consumer', requires: ['voice-engine'] }),
      def({ id: 'provider', provides: ['voice-engine'] }),
    ],
    enabledOf: () => true,
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.deepEqual(plan.load.map((d) => d.id), ['provider', 'consumer'], '提供方先装，依赖方后装')
  assert.equal(plan.skipped.length, 0)
})

test('T3.9 planModules：conflicts 双向生效（冲突方先声明也不许后者偷偷装进来）', () => {
  const def = (over) => ({ id: 'm', version: '1.0.0', setup: () => ({}), ...over })
  const plan = planModules({
    defs: [
      def({ id: 'hater', conflicts: ['tts'] }),
      def({ id: 'impl', provides: ['tts'] }),
    ],
    enabledOf: () => true,
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.deepEqual(plan.load.map((d) => d.id), ['hater'])
  assert.equal(plan.skipped[0].id, 'impl')
  assert.match(plan.skipped[0].reason, /冲突/)
})

test('T3.9 planModules：环形依赖整组装载，不因声明顺序互相卡死', () => {
  const def = (over) => ({ id: 'm', version: '1.0.0', setup: () => ({}), ...over })
  const plan = planModules({
    defs: [
      def({ id: 'ring-a', provides: ['a-cap'], requires: ['b-cap'] }),
      def({ id: 'ring-b', provides: ['b-cap'], requires: ['a-cap'] }),
    ],
    enabledOf: () => true,
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.deepEqual(plan.load.map((d) => d.id).sort(), ['ring-a', 'ring-b'])
  assert.equal(plan.skipped.length, 0)
})
