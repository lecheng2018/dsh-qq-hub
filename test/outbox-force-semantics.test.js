// force 的边界（2026-11-12 收窄）：
//   force 只豁免「总开关关闭」——让 /on 这类命令在关闸后仍能回话（自救通道）；
//   它不豁免 dryRun（试运行就是不真发），也不豁免身份泄露闸（命令回复同样会带出号码）。
//
// 历史行为：force 三者全豁免。默认姿态是「总开关关 + 试运行开」，
// 于是主人一发 /status，回复就真的发到 QQ 了，且这条回复不经过泄露闸。
//
// 覆盖两套出口：统一 Outbox（默认链路）与 legacy sendSegments（FLAG_MODULAR_CORE=false 逃生阀）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createOutbox } from '../src/chat/outbox.js'

const segs = (text = '你好') => [{ type: 'text', data: { text } }]

/** 记录物理发送次数的最小网关。 */
function countingGateway() {
  const calls = []
  return {
    calls,
    send: async (action, params) => { calls.push({ action, params }); return { messageId: `gw-${calls.length}` } },
  }
}

// ---------- 统一 Outbox（默认链路）----------

test('force 不豁免 dryRun：试运行开着时，命令回复也不真发', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => true, enabled: () => false })
  // 命令回复的真实形态（hub.js / modular-core.js 里是 force:true）
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('/status 的回复'), force: true })
  assert.equal(r.state, 'cancelled', '试运行没关，force 也不能真发')
  assert.equal(r.reason, 'dryRun')
  assert.equal(gw.calls.length, 0, '物理发送必须为 0 次')
})

test('force 仍豁免总开关：这是 /on 的自救通道，不能一起收掉', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => false, enabled: () => false })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('总开关：已打开'), force: true })
  assert.equal(r.state, 'sent', '总开关关着时 force 必须还能发，否则用户把自己锁在门外')
  assert.equal(gw.calls.length, 1)
})

test('非 force 的普通回复：总开关关着照样不发（收窄没有把闸拆掉）', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => false, enabled: () => false })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('普通回复') })
  assert.equal(r.state, 'cancelled')
  assert.equal(r.reason, '总开关关闭')
  assert.equal(gw.calls.length, 0)
})

test('force 不豁免身份泄露闸：命令回复里带出别人的号照样拦下', async () => {
  const gw = countingGateway()
  let guardCalls = 0
  const outbox = createOutbox({
    send: gw.send,
    dryRun: () => false,
    enabled: () => true,
    guard: () => { guardCalls += 1; return { ok: false, message: '含主人 QQ' } },
  })
  const r = await outbox.request({ chatKey: 'group:20002', segments: segs('他的号是 10000001'), force: true })
  assert.equal(guardCalls, 1, '闸必须被调用（以前 force 直接跳过，guardCalls 恒为 0）')
  assert.equal(r.state, 'cancelled')
  assert.match(r.reason, /身份泄露闸/)
  assert.equal(gw.calls.length, 0)
})

test('闸放行时 force 走完正常链路：豁免收窄不等于把闸做成死路', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({
    send: gw.send,
    dryRun: () => false,
    enabled: () => true,
    guard: () => ({ ok: true }),
  })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('总开关：已打开'), force: true })
  assert.equal(r.state, 'sent')
  assert.equal(gw.calls.length, 1)
})

// ---------- legacy sendSegments（逃生阀链路）----------
// 这条链路只在 FLAG_MODULAR_CORE=false 时启用，没有现成的端口级测试夹具；
// 用源码形态断言钉住两处闸门，避免以后被「顺手加回 !force」改掉（与 outbound-guard 的既有做法一致）。

const HUB = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')

test('legacy：身份闸不再因 force 豁免', () => {
  const ig = HUB.slice(HUB.indexOf('const igCfg = cfg.security?.identityGuard'), HUB.indexOf('const igCfg = cfg.security?.identityGuard') + 400)
  assert.match(ig, /if \(igCfg\.enabled !== false\) \{/, '身份闸应只看开关，不再带 !force')
  assert.doesNotMatch(ig, /enabled !== false && !force/, '不能退回「force 豁免身份闸」')
})

test('legacy：dryRun 不在 force 分支里被跳过', () => {
  // 旧写法是 `if (force) {}` 空块——force 直接落到底部真发
  assert.doesNotMatch(HUB, /if \(force\) \{\}/, '不能保留「force 直接放行」的空分支')
  const gate = HUB.slice(HUB.indexOf('// 全局闸：force 只豁免总开关'), HUB.indexOf('// 全局闸：force 只豁免总开关') + 400)
  assert.match(gate, /if \(!force && !cfg\.enabled\)/, '总开关可被 force 豁免')
  assert.match(gate, /else if \(cfg\.dryRun\)/, '试运行必须无条件挡住（force 也挡）')
})
