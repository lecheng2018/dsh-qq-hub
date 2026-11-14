// 投递异常面板（delivery-inbox）的回归网。
//
// 为什么需要它：投递台账从 PR-1 起就如实记 unknown/failed/cancelled，但一直没有出口 ——
// 「记了没人看」。这个模块补上出口，而出口最容易犯的错是**把读失败显示成没问题**：
// 文件缺失/损坏时如果返回空列表，主人会以为一切正常，实际是排查入口自己瞎了。
// 所以本文件重点守：读不到必须明确报错、异常状态必须完整列出、正常状态不许混进来。
import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeDeliveries } from '../src/modules/delivery-inbox/index.js'

const NOW = 1_800_000_000_000

/** 造一条台账记录（字段与真实 deliveries.json 一致）。 */
function rec(over = {}) {
  return {
    contractVersion: 1,
    deliveryId: 'dlv-1',
    chatKey: 'group:123',
    sourceModuleId: 'core',
    state: 'unknown',
    attemptCount: 1,
    segments: [{ type: 'text', data: { text: '你好世界' } }],
    contentChars: 4,
    createdAt: NOW - 60_000,
    ...over,
  }
}

const doc = (deliveries) => ({ version: 1, savedAt: NOW, deliveries })

// ---------------------------------------------------------------------------
// 读不到 ≠ 没问题（最重要的一条）
// ---------------------------------------------------------------------------

test('台账读不到时明确报告，绝不伪装成「没有异常」', () => {
  for (const bad of [null, undefined, {}, [], 'x', 42, { deliveries: 'nope' }]) {
    const r = summarizeDeliveries(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应报 ok:false`)
    assert.equal(r.reason, 'deliveries-unreadable')
    assert.deepEqual(r.items, [], '不该给出任何条目（避免被当成"没有异常"）')
  }
})

test('空台账是「真的没有异常」，与读不到要能区分', () => {
  const r = summarizeDeliveries(doc([]))
  assert.equal(r.ok, true, '读到了 → ok:true')
  assert.deepEqual(r.items, [])
  assert.equal(r.total, 0)
})

// ---------------------------------------------------------------------------
// 只列异常，正常状态不许混进来
// ---------------------------------------------------------------------------

test('只列 unknown / failed / cancelled；sent 与 queued 不进面板', () => {
  const r = summarizeDeliveries(doc([
    rec({ deliveryId: 'a', state: 'unknown' }),
    rec({ deliveryId: 'b', state: 'failed' }),
    rec({ deliveryId: 'c', state: 'cancelled' }),
    rec({ deliveryId: 'd', state: 'sent' }),
    rec({ deliveryId: 'e', state: 'queued' }),
  ]))
  assert.deepEqual(r.items.map((i) => i.deliveryId), ['a', 'b', 'c'])
  assert.equal(r.total, 5, 'total 是台账总条数（含正常的），用于说明规模')
  assert.equal(r.counts.sent, 1, 'counts 要能看出有多少已送达')
})

test('按发生时间倒序：最近的要排在最上面', () => {
  const r = summarizeDeliveries(doc([
    rec({ deliveryId: 'old', unknownAt: NOW - 3600_000 }),
    rec({ deliveryId: 'new', unknownAt: NOW - 1000 }),
    rec({ deliveryId: 'mid', unknownAt: NOW - 60_000 }),
  ]))
  assert.deepEqual(r.items.map((i) => i.deliveryId), ['new', 'mid', 'old'])
})

test('没有发生时间时退回 createdAt 排序（不让条目凭空消失）', () => {
  const r = summarizeDeliveries(doc([rec({ deliveryId: 'x', createdAt: NOW - 5000, unknownAt: undefined })]))
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].at, NOW - 5000, '应退回 createdAt')
})

// ---------------------------------------------------------------------------
// 理由字段的三种来源
// ---------------------------------------------------------------------------

test('失败理由按终态取对应字段（unknownReason / failReason / cancelReason）', () => {
  const r = summarizeDeliveries(doc([
    rec({ deliveryId: 'u', state: 'unknown', unknownReason: '网关超时' }),
    rec({ deliveryId: 'f', state: 'failed', failReason: '群不存在' }),
    rec({ deliveryId: 'c', state: 'cancelled', cancelReason: '总开关关着' }),
  ]))
  const byId = Object.fromEntries(r.items.map((i) => [i.deliveryId, i.reason]))
  assert.equal(byId.u, '网关超时')
  assert.equal(byId.f, '群不存在')
  assert.equal(byId.c, '总开关关着')
})

test('没有理由字段时给空串，不编造', () => {
  const r = summarizeDeliveries(doc([rec({ state: 'failed', failReason: undefined })]))
  assert.equal(r.items[0].reason, '')
})

// ---------------------------------------------------------------------------
// 正文预览：够认出来就行，不摊全文
// ---------------------------------------------------------------------------

test('正文预览截断到 60 字并加省略号（面板不该摊全文）', () => {
  const long = '字'.repeat(200)
  const r = summarizeDeliveries(doc([rec({ segments: [{ type: 'text', data: { text: long } }] })]))
  const preview = r.items[0].preview
  assert.equal(Array.from(preview).length, 61, `应为 60 字 + 省略号（实际 ${Array.from(preview).length}）`)
  assert.ok(preview.endsWith('…'))
})

test('正文预览把非文字段换成可读占位（能认出是哪条消息）', () => {
  const r = summarizeDeliveries(doc([rec({
    segments: [
      { type: 'reply', data: { id: '9' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { url: 'x' } },
      { type: 'face', data: { id: '1' } },
    ],
  })]))
  const p = r.items[0].preview
  assert.match(p, /\[引用\]/)
  assert.match(p, /@10001/)
  assert.match(p, /看这个/)
  assert.match(p, /\[图片\]/)
  assert.match(p, /\[表情\]/)
})

test('没有可展示内容时给空串（面板据此显示占位文案）', () => {
  for (const segs of [[], undefined, null, [{ type: 'text', data: { text: '   ' } }]]) {
    const r = summarizeDeliveries(doc([rec({ segments: segs })]))
    assert.equal(r.items[0].preview, '', `segments=${JSON.stringify(segs)} 应为空预览`)
  }
})

// ---------------------------------------------------------------------------
// 容量与健壮性
// ---------------------------------------------------------------------------

test('limit 生效且有上限（不把一屏撑爆）', () => {
  const many = Array.from({ length: 200 }, (_, i) => rec({ deliveryId: `d${i}`, unknownAt: NOW - i * 1000 }))
  assert.equal(summarizeDeliveries(doc(many)).items.length, 50, '默认最多 50 条')
  assert.equal(summarizeDeliveries(doc(many), { limit: 5 }).items.length, 5)
  assert.equal(summarizeDeliveries(doc(many), { limit: 9999 }).items.length, 50, '超过 50 仍夹到 50')
  assert.equal(summarizeDeliveries(doc(many), { limit: 0 }).items.length, 50, '非法 limit 回默认')
  assert.equal(summarizeDeliveries(doc(many), { limit: -3 }).items.length, 50)
})

test('坏记录被跳过而不是让整个面板崩掉', () => {
  const r = summarizeDeliveries(doc([
    rec({ deliveryId: 'good', state: 'unknown' }),
    null, undefined, 'x', 42,
    rec({ deliveryId: 'alsogood', state: 'failed' }),
  ]))
  assert.equal(r.ok, true)
  assert.deepEqual(r.items.map((i) => i.deliveryId).sort(), ['alsogood', 'good'])
})

test('字段缺省不崩（老版本台账没有 action/note/source）', () => {
  const r = summarizeDeliveries(doc([{ deliveryId: 'x', chatKey: 'private:1', state: 'unknown' }]))
  assert.equal(r.ok, true)
  const it = r.items[0]
  assert.equal(it.source, '')
  assert.equal(it.action, '')
  assert.equal(it.note, '')
  assert.equal(it.attemptCount, 0)
  assert.equal(it.contentChars, 0)
})

test('counts 覆盖所有状态（面板要能说清"台账里都有什么"）', () => {
  const r = summarizeDeliveries(doc([
    rec({ state: 'sent' }), rec({ state: 'sent' }), rec({ state: 'unknown' }), rec({ state: 'queued' }),
  ]))
  assert.deepEqual(r.counts, { sent: 2, unknown: 1, queued: 1 })
})
