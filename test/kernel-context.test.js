// Context 工厂：meta 只读、inbound 引用、reply 队列不可变语义、state 键隔离、abort 语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from '../src/kernel/context.js'

function envelope(over = {}) {
  return {
    id: 'evt-1',
    protocol: 'onebot:v11',
    type: 'message',
    timestamp: Date.now(),
    selfId: 'bot-1',
    sender: { userId: 'u-1', nickname: '群友' },
    segments: [{ type: 'text', data: { text: 'hello' } }],
    rawText: 'hello',
    rawPayload: {},
    ...over,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('meta：traceId/spanId/receivedAt/driverId 齐备且冻结', () => {
  const ctx = createContext(envelope(), 'onebot-driver')
  assert.match(ctx.meta.traceId, UUID_RE)
  assert.match(ctx.meta.spanId, /^[0-9a-f]{16}$/)
  assert.equal(ctx.meta.driverId, 'onebot-driver')
  assert.equal(typeof ctx.meta.receivedAt, 'number')
  assert.ok(Object.isFrozen(ctx.meta))
  assert.throws(() => { ctx.meta.traceId = 'tampered' }, TypeError)
})

test('meta：parentTraceId 透传，全链路复用同一条 trace', () => {
  const ctx = createContext(envelope(), 'driver-a', 'parent-trace-001')
  assert.equal(ctx.meta.traceId, 'parent-trace-001')
  assert.notEqual(ctx.meta.spanId, undefined, 'spanId 仍应新起')
})

test('inbound：原样引用驱动层信封，不做二次拷贝', () => {
  const env = envelope()
  const ctx = createContext(env, 'driver-a')
  assert.equal(ctx.inbound, env)
})

test('reply：enqueue 自动生成 id/createdAt，条目与 segments 均冻结', () => {
  const ctx = createContext(envelope(), 'driver-a')
  assert.equal(ctx.reply.isEmpty(), true)
  const segs = [{ type: 'text', data: { text: 'hi' } }]
  ctx.reply.enqueue({ targetType: 'private', targetId: 'u-1', segments: segs, priority: 'NORMAL' })
  assert.equal(ctx.reply.isEmpty(), false)
  assert.equal(ctx.reply.queue.length, 1)
  const item = ctx.reply.queue[0]
  assert.match(item.id, UUID_RE)
  assert.equal(typeof item.createdAt, 'number')
  assert.ok(Object.isFrozen(item), '条目应冻结')
  assert.ok(Object.isFrozen(item.segments), 'segments 应冻结')
  assert.throws(() => { item.targetId = 'x' }, TypeError)
  assert.throws(() => { item.segments.push({ type: 'text', data: { text: '偷加' } }) }, TypeError)
  segs.push({ type: 'text', data: { text: 'later' } })
  assert.equal(item.segments.length, 1, '入队拷贝与源数组脱钩')
})

test('reply：多条入队保持 FIFO，clear 后可继续 enqueue', () => {
  const ctx = createContext(envelope(), 'driver-a')
  const mk = (t) => ({ targetType: 'group', targetId: '555', segments: [{ type: 'text', data: { text: t } }], priority: 'NORMAL' })
  ctx.reply.enqueue(mk('一'))
  ctx.reply.enqueue(mk('二'))
  assert.deepEqual(ctx.reply.queue.map((p) => p.segments[0].data.text), ['一', '二'])
  const ids = ctx.reply.queue.map((p) => p.id)
  assert.notEqual(ids[0], ids[1], '每条 id 唯一')
  ctx.reply.clear()
  assert.equal(ctx.reply.isEmpty(), true)
  assert.equal(ctx.reply.queue.length, 0)
  ctx.reply.enqueue(mk('三'))
  assert.equal(ctx.reply.queue.length, 1)
})

test('state：symbol 与 string 同名键互不干扰', () => {
  const ctx = createContext(envelope(), 'driver-a')
  const key = Symbol('slot')
  const ret = ctx.state.set('slot', 'string 值').set(key, 'symbol 值')
  assert.equal(ret, ctx.state, 'set 支持链式调用')
  assert.equal(ctx.state.get('slot'), 'string 值')
  assert.equal(ctx.state.get(key), 'symbol 值')
  assert.equal(ctx.state.has('slot'), true)
  assert.equal(ctx.state.has(key), true)
  assert.equal(ctx.state.delete('slot'), true)
  assert.equal(ctx.state.has('slot'), false)
  assert.equal(ctx.state.has(key), true, '删 string 键不影响 symbol 键')
  assert.equal(ctx.state.get('不存在'), undefined)
})

test('state：toMap 返回快照副本，改动不回写原容器', () => {
  const ctx = createContext(envelope(), 'driver-a')
  ctx.state.set('a', 1)
  const snap = ctx.state.toMap()
  assert.equal(snap.get('a'), 1)
  snap.set('a', 2)
  snap.set('b', 3)
  assert.equal(ctx.state.get('a'), 1)
  assert.equal(ctx.state.has('b'), false)
})

test('abort：signal.aborted 与 reason 语义（显式原因 / 默认 AbortError）', () => {
  const ctx = createContext(envelope(), 'driver-a')
  assert.equal(ctx.signal.aborted, false)
  assert.equal(ctx.signal, ctx.signal, 'signal getter 稳定返回同一对象')
  ctx.abort('superseded')
  assert.equal(ctx.signal.aborted, true)
  assert.equal(ctx.signal.reason, 'superseded')

  const ctx2 = createContext(envelope(), 'driver-a')
  ctx2.abort()
  assert.equal(ctx2.signal.aborted, true)
  assert.equal(ctx2.signal.reason?.name, 'AbortError')
})
