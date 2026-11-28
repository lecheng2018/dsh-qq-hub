// Batch 3 · T3.6：热重载/取消语义下的定时器与早退
//
// 改前：
//   ① approvals/questions 只在事后监听 signal.abort —— 请求进来时 signal 已经 aborted 时
//      监听器永远不会触发，主人照样收到早已作废的审批/提问卡，pending 永久挂着；
//   ② module-send-bridge 把「静默时段挡下的汇总」暂存时不带 delayMs → 不挂补发定时器，
//      汇总要等模块下次发消息才可能被 flush（多半永远躺在内存里）。
// 这里直接跑真实模块。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalRegistry } from '../src/chat/approvals.js'
import { createQuestionRegistry } from '../src/chat/questions.js'
import { createModuleSendBridge } from '../src/host/module-send-bridge.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {} }
const OWNER_QQ = '10000001'

test('T3.6 approvals：进来就已 aborted → 不发卡、不挂 pending', async () => {
  const delivered = []
  const approvals = createApprovalRegistry({
    deliver: async (chatId, text) => { delivered.push({ chatId, text }) },
    ownerQQ: () => OWNER_QQ,
    log: noopLog,
  })
  const controller = new AbortController()
  controller.abort()
  const verdict = await approvals.request(
    { signal: controller.signal },
    { chatId: 'group:777', sessionId: 's1', command: 'bash', args: { command: 'rm -rf /tmp/x' }, reason: '危险命令' },
  )
  assert.equal(verdict, 'cancelled')
  assert.equal(delivered.length, 0, '已取消的请求不许再把审批卡发给主人')
  const pending = typeof approvals.pending === 'function' ? approvals.pending() : approvals.list?.() || []
  assert.equal(pending.length, 0, '不许留下永久挂起的审批')
})

test('T3.6 questions：进来就已 aborted → 立刻拒绝、不发卡', async () => {
  const delivered = []
  const questions = createQuestionRegistry({
    deliver: async (chatId, text) => { delivered.push({ chatId, text }) },
    log: noopLog,
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => questions.ask('private:10000001', {
      signal: controller.signal,
      sessionId: 's1',
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
    }),
    /中止/,
  )
  assert.equal(delivered.length, 0, '已取消的提问不许再发卡')
})

test('T3.6 静默时段被挡下的汇总必须挂上补发定时器（scheduled=true）', async () => {
  const sent = []
  const fakeNow = new Date('2026-11-28T02:00:00').getTime() // 落在静默时段 [1, 7] 内
  const bridge = createModuleSendBridge({
    hub: { isBusy: () => false },
    outbox: { request: async (req) => { sent.push(req); return { state: 'sent', gatewayMessageId: 'gw-1' } } },
    log: noopLog,
    pushPolicy: { enabled: true, pacingMs: 0, quietHours: [1, 7], digestEnabled: true },
    now: () => fakeNow,
  })
  const r = await bridge.sendText('private:10000001', '深夜播报：今日份日报已生成', 'daily-report')
  assert.equal(r.state, 'digested')
  assert.equal(r.reason, 'quiet-hours')
  const pending = bridge.pendingDigests()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].scheduled, true, '静默挡下的汇总必须有补发定时器（否则永远发不出去）')
  assert.equal(sent.length, 0, '静默时段内不发送')
  bridge.dispose()
  assert.equal(bridge.pendingDigests().length, 0, '卸载后汇总缓冲必须清空')
})

test('T3.6 模块发送桥 dispose 后已排的补发定时器不许再发（热重载不留僵尸定时器）', async () => {
  const sent = []
  const bridge = createModuleSendBridge({
    hub: { isBusy: () => false },
    outbox: { request: async (req) => { sent.push(req); return { state: 'sent', gatewayMessageId: 'gw-1' } } },
    log: noopLog,
    pushPolicy: { enabled: true, pacingMs: 0, digestEnabled: true, quietHours: null },
  })
  // 直接构造一个已暂存且带 30ms 定时器的缓冲（burst 分支的真实路径：超限后延迟汇总）
  const burstBridge = createModuleSendBridge({
    hub: { isBusy: () => false },
    outbox: { request: async (req) => { sent.push(req); return { state: 'sent', gatewayMessageId: 'gw-1' } } },
    log: noopLog,
    pushPolicy: { enabled: true, pacingMs: 0, burstLimit: 1, burstWindowMs: 60_000, digestEnabled: true, quietHours: null },
  })
  await burstBridge.sendText('private:10000001', '第一条', 'm1')
  const r2 = await burstBridge.sendText('private:10000001', '第二条', 'm1')
  assert.equal(r2.state, 'digested')
  assert.equal(r2.reason, 'burst-limit')
  assert.equal(burstBridge.pendingDigests()[0].scheduled, true, '超限分支也必须挂定时器')
  burstBridge.dispose()
  await sleep(80)
  assert.equal(sent.length, 1, '卸载后定时器不许再触发发送')
  bridge.dispose()
})
