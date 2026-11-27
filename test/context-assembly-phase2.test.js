// Context Assembly Phase 2 的时空标尺 provider 与装配隔离回归网。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TIME_SCALE_PROVIDER_ID,
  createContextAssembly,
  createTimeScaleProvider,
} from '../src/chat/context-assembly.js'

const NOW = 1_800_000_000_000
const CHAT = 'private:10001'

// ---------------------------------------------------------------------------
// createTimeScaleProvider
// ---------------------------------------------------------------------------

test('时空 provider：resolveLastAt 非函数时立即拒', () => {
  assert.throws(() => createTimeScaleProvider({ resolveLastAt: 'x' }), TypeError)
  assert.doesNotThrow(() => createTimeScaleProvider({}))
})

test('时空 provider：perChat 下按本会话上一轮时间注入相对时间感', () => {
  const p = createTimeScaleProvider({
    perChat: true,
    resolveLastAt: (key) => (key === CHAT ? NOW - 45 * 60_000 : undefined),
    now: () => NOW,
  })
  const out = p.provide({ chatKey: CHAT })
  assert.match(out, /时空标尺/, '应注入时空标尺')
  assert.match(out, /45/, `应体现约 45 分钟（实际 ${out}）`)
})

test('时空 provider：没有时间源就不编造（返回空串）', () => {
  const p = createTimeScaleProvider({ perChat: true, now: () => NOW })
  assert.equal(p.provide({ chatKey: CHAT }), '', '没有 resolveLastAt 时不许凭空写时间')
})

test('时空 provider：上一轮时间非法/缺失时不注入', () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, 'x', {}]) {
    const p = createTimeScaleProvider({ perChat: true, resolveLastAt: () => bad, now: () => NOW })
    assert.equal(p.provide({ chatKey: CHAT }), '', `resolveLastAt=${JSON.stringify(bad)} 不该注入`)
  }
})

test('时空 provider：无 scope / 非法 chatKey 一律 fail-closed', () => {
  const p = createTimeScaleProvider({ resolveLastAt: () => NOW - 1000, now: () => NOW })
  assert.equal(p.provide({ chatKey: CHAT }), '', '未绑 scope 不注入')
  const q = createTimeScaleProvider({ perChat: true, resolveLastAt: () => NOW - 1000, now: () => NOW })
  for (const bad of ['', null, 'nonsense']) assert.equal(q.provide({ chatKey: bad }), '')
})

test('时空 provider：声明形状完整', () => {
  const p = createTimeScaleProvider({ perChat: true })
  assert.equal(p.moduleId, TIME_SCALE_PROVIDER_ID)
  assert.equal(p.onError, 'isolate')
  assert.equal(typeof p.priority, 'number')
})

// ---------------------------------------------------------------------------
// 与装配器联动：出错必须只跳自己
// ---------------------------------------------------------------------------

test('装配器：单个 provider 抛错时被 isolate，其余上下文照常注入', async () => {
  const boom = {
    moduleId: 'boom-provider',
    priority: 800,
    scope: 'global',
    onError: 'isolate',
    provide: () => { throw new Error('provider 炸了') },
  }
  const ok = {
    moduleId: 'ok-provider',
    priority: 700,
    scope: 'global',
    onError: 'isolate',
    provide: () => '正常上下文',
  }
  const asm = createContextAssembly({ providers: [boom, ok] })
  const res = await asm.assemble({ chatKey: CHAT })
  const joined = JSON.stringify(res)
  assert.match(joined, /正常上下文/, '坏 provider 不能拖垮好的')
  assert.ok(res.errors?.length >= 1, '坏 provider 的错误要被记进 errors（可审计），而不是静默吞掉')
})

test('装配器：无可信 chatKey 时 fail-closed 抛错（调用方先修 ChatKey）', async () => {
  const asm = createContextAssembly({ providers: [] })
  await assert.rejects(() => asm.assemble({ chatKey: 'nonsense' }), /ChatKey|chatKey/i)
})
