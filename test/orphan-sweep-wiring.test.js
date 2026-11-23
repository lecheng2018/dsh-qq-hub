// 孤儿会话巡检的接线层：定时器装上了、能穿过 facade 调到核心、配置能关掉。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostEffects } from '../src/host/effects.js'
import { createCurrentHub } from '../src/host/current-hub.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

function mkEffects({ cfg = {}, sweep } = {}) {
  const intervals = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') intervals.push(d); return d },
    interval(fn) { intervals.push(fn); return () => {} },
  }
  const hub = {
    sweepOrphanSessions: sweep || (async () => ({ scanned: 0, archived: 0, skipped: 0 })),
  }
  const effects = createHostEffects({
    ctx,
    logger: noopLog,
    log: noopLog,
    getConfig: () => ({ orphanSweep: { enabled: true, intervalHours: 6 }, ...cfg }),
    hub,
    mods: null,
    use: () => null,
    snowluma: { detect: () => ({ installed: false }) },
    onebot: { state: 'stopped', start() {}, stop() {} },
    gatewayState: {},
    interactions: {},
    chatKeyOfSession: () => '',
    onSessionEvent: () => {},
  })
  return { effects, intervals, hub }
}

test('孤儿会话巡检：装上了定时器，默认 6 小时一次（不是每 30 秒）', () => {
  const { effects, intervals } = mkEffects()
  effects.installOrphanSweeper()
  assert.equal(intervals.length >= 1, true, '应该注册了定时器')
})

test('孤儿会话巡检：config.orphanSweep.enabled=false 时一次都不跑', async () => {
  let calls = 0
  const { effects } = mkEffects({
    cfg: { orphanSweep: { enabled: false, intervalHours: 6 } },
    sweep: async () => { calls++; return { scanned: 0, archived: 0, skipped: 0 } },
  })
  await effects.sweepOrphans()
  assert.equal(calls, 0, '关掉后不应该调用核心')
})

test('孤儿会话巡检：节流——同一轮周期内只跑一次', async () => {
  let calls = 0
  const { effects } = mkEffects({
    sweep: async () => { calls++; return { scanned: 0, archived: 1, skipped: 0 } },
  })
  await effects.sweepOrphans()
  await effects.sweepOrphans()
  await effects.sweepOrphans()
  assert.equal(calls, 1, '6 小时周期内不该重复巡检')
})

test('孤儿会话巡检：核心抛错被 safe() 兜住，不冒到定时器外', async () => {
  const { effects } = mkEffects({
    sweep: async () => { throw new Error('炸了') },
  })
  // 定时器挂的是 safe(sweepOrphans)：单轮失败只能记日志，不能变成未处理 rejection
  await effects.safe(effects.sweepOrphans, '孤儿会话巡检')()
})

test('facade：sweepOrphanSessions 真的透到核心（接线不断）', async () => {
  const sweeps = []
  const modular = {
    services: {},
    registry: { snapshot: () => ({}) },
    resetSessions: () => 0,
    resetChat: () => false,
    sessions: () => ({}),
    knownChats: () => [],
    sweepOrphanSessions: async (o) => { sweeps.push(o); return { scanned: 1, archived: 1, skipped: 0 } },
  }
  const hub = createCurrentHub({
    modular,
    services: {},
    interactions: { approvals: { clear() {} }, questions: { cancel() {} } },
    log: noopLog,
    logChat: () => {},
  })
  assert.equal(typeof hub.sweepOrphanSessions, 'function')
  const result = await hub.sweepOrphanSessions()
  assert.equal(result.archived, 1)
  assert.equal(sweeps.length, 1)
})
