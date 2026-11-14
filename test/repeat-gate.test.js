// 重复日志去重闸的回归网（真机反馈：「群闸：不回——插话关着」「ACL 拒绝：不在群白名单」刷屏）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRepeatGate } from '../src/core/repeat-gate.js'

/** 可推进的假时钟。 */
function clock(start = 1_800_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('第一条必放（不能把状态起点吞掉）', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 1000, nowFn: c.now })
  const r = gate('gate:group:1', '插话关着')
  assert.equal(r.emit, true)
  assert.equal(r.suppressed, 0, '首发不带汇总尾巴')
})

test('窗口内同款判定全沉默并累计', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 60_000, nowFn: c.now })
  gate('k', 'same')
  for (let i = 0; i < 50; i += 1) {
    c.advance(100) // 5 秒内 50 条
    const r = gate('k', 'same')
    assert.equal(r.emit, false)
    assert.equal(r.suppressed, i + 1)
  }
})

test('满窗口补一条带「已静默 N 条」，计数清零重新攒', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 60_000, nowFn: c.now })
  gate('k', 'same')
  for (let i = 0; i < 10; i += 1) { c.advance(5000); gate('k', 'same') }
  c.advance(10_000) // 累计满 60 秒
  const r = gate('k', 'same')
  assert.equal(r.emit, true, '到窗口要放一条心跳')
  assert.equal(r.suppressed, 10, '只报窗口内攒下的条数')
  // 下一条同款回到静默，计数从头
  c.advance(1000)
  const r2 = gate('k', 'same')
  assert.equal(r2.emit, false)
  assert.equal(r2.suppressed, 1)
})

test('判定变了立刻放（状态转变是日志里最想知道的东西）', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 60_000, nowFn: c.now })
  gate('gate:group:1', '插话关着')
  c.advance(1000)
  gate('gate:group:1', '插话关着') // 被静默
  c.advance(1000)
  const r = gate('gate:group:1', '静默时段') // 换理由
  assert.equal(r.emit, true, '理由变化必须马上可见')
  assert.equal(r.suppressed, 0, '转变行不带旧理由的计数（旧账作废）')
})

test('不同会话互不影响（按 gateKey 隔离）', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 60_000, nowFn: c.now })
  assert.equal(gate('acl:group:1', 'x').emit, true)
  assert.equal(gate('acl:group:2', 'x').emit, true, '另一个群的第一条不该被 group:1 的静默吞掉')
  assert.equal(gate('acl:group:1', 'x').emit, false)
})

test('空键一律放行（去重器宁可多打也不吞日志）', () => {
  const gate = createRepeatGate({ windowMs: 60_000 })
  for (let i = 0; i < 5; i += 1) assert.equal(gate('', 'x').emit, true)
  for (let i = 0; i < 5; i += 1) assert.equal(gate(null, 'x').emit, true)
})

test('键位有上限：驱逐最久未放行的，不会无限膨胀', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 60_000, maxKeys: 3, nowFn: c.now })
  gate('a', 'x'); c.advance(1000)
  gate('b', 'x'); c.advance(1000)
  gate('c', 'x'); c.advance(1000)
  const r = gate('d', 'x') // 挤掉 a
  assert.equal(r.emit, true)
  const rA = gate('a', 'x') // a 的静默记忆已没了 → 当新的放行
  assert.equal(rA.emit, true, '被驱逐的键重新计时，功能退化为多打一条，不丢日志')
})

test('非法 windowMs 回默认（配置坏掉不能变成全静默）', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 0, nowFn: c.now })
  assert.equal(gate('k', 's').emit, true)
  c.advance(1000)
  assert.equal(gate('k', 's').emit, false, '0 窗口回落到 5 分钟默认，仍能静默')
  c.advance(300_000)
  assert.equal(gate('k', 's').emit, true, '默认窗口到期照常心跳')
})

test('真实刷屏形态：每 3 秒一条恒定判定，一小时只有 12 条日志', () => {
  const c = clock()
  const gate = createRepeatGate({ windowMs: 300_000, nowFn: c.now })
  let emitted = 0
  for (let i = 0; i < 1200; i += 1) { // 一小时 = 1200 条（3 秒一条）
    if (gate('gate:group:995845542', '插话关着').emit) emitted += 1
    c.advance(3000)
  }
  assert.equal(emitted, 12, `一小时最多 1 首发 + 11 条心跳（实际 ${emitted}）`)
})
