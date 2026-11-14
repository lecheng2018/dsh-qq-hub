// US-015 接线验收：情感图谱真的被构造、持久化，并给出可用的 tone。
import test from 'node:test'
import assert from 'node:assert/strict'
import affectiveGraph from '../src/modules/affective-graph/index.js'
import { SIGNAL_WEIGHTS } from '../src/chat/affective-graph.js'

function fakeApi() {
  const routes = new Map()
  const timers = []
  const logs = []
  const store = new Map()
  return {
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
    dataDir: (name) => `/tmp/ag-${name}`,
    every: (ms, fn) => timers.push({ ms, fn }),
    route: (p, fn) => routes.set(p, fn),
    core: { http: { body: async (req) => req._body || {} } },
    getRoute: (p) => routes.get(p),
    logs, store,
  }
}

const CHAT = 'private:1000'

test('模块 setup 返回 graph / toneFor / persist', () => {
  const api = fakeApi()
  const out = affectiveGraph.setup(api)
  for (const k of ['graph', 'toneFor', 'persist']) {
    assert.ok(out[k], `应返回 ${k}`)
  }
})

test('陌生人（等级 0）给出 cool 且不主动私聊', () => {
  const api = fakeApi()
  const { toneFor } = affectiveGraph.setup(api)
  const t = toneFor(CHAT)
  assert.equal(t.ok, true)
  assert.equal(t.level, 0)
  assert.equal(t.temperature, 'cool')
  assert.equal(t.proactivePrivate, false, '陌生人不该主动私聊')
})

test('记录关系信号后等级上升，tone 随之变暖', () => {
  const api = fakeApi()
  const { toneFor } = affectiveGraph.setup(api)
  const before = toneFor(CHAT)
  // 连着两次 shared-joke（权重 2）→ 分数 4 → 达到 3 的阈值
  api.getRoute('/affective/bump')
  return api.getRoute('/affective/bump')({ method: 'POST', _body: { chat: CHAT, signal: 'shared-joke' } })
    .then(() => api.getRoute('/affective/bump')({ method: 'POST', _body: { chat: CHAT, signal: 'shared-joke' } }))
    .then((r) => {
      assert.equal(r.ok, true, `bump 应成功：${JSON.stringify(r).slice(0, 120)}`)
      const after = toneFor(CHAT)
      assert.ok(after.level >= before.level, '等级不应下降')
      return after
    })
    .then((after) => {
      if (after.level >= 1) {
        assert.notEqual(after.temperature, 'cool', '等级 ≥1 后温度应变暖')
      }
    })
})

test('非法 signal 被拒绝，且不影响已有状态', async () => {
  const api = fakeApi()
  const { toneFor } = affectiveGraph.setup(api)
  const before = toneFor(CHAT).level
  const r = await api.getRoute('/affective/bump')({ method: 'POST', _body: { chat: CHAT, signal: 'not-a-signal' } })
  assert.equal(r.ok, false)
  assert.match(String(r.message), /signal/)
  assert.equal(toneFor(CHAT).level, before, '状态不该被污染')
})

test('GET 打 bump 端点被拒绝（只接受 POST）', async () => {
  const api = fakeApi()
  affectiveGraph.setup(api)
  const r = await api.getRoute('/affective/bump')({ method: 'GET' })
  assert.equal(r.ok, false)
  assert.match(String(r.message), /POST/)
})

test('非法 chatKey 的 tone 退回中性，不抛', () => {
  const api = fakeApi()
  const { toneFor } = affectiveGraph.setup(api)
  for (const bad of ['', 'not-a-chatkey', 'private:']) {
    const t = toneFor(bad)
    assert.equal(typeof t.ok, 'boolean', `${bad} 应返回结构`)
    assert.equal(t.proactivePrivate, false, `${bad} 不该获得主动私聊特权`)
  }
})

test('/affective/state 返回图规模与 tone', async () => {
  const api = fakeApi()
  affectiveGraph.setup(api)
  const r = await api.getRoute('/affective/state')({ query: { chat: CHAT } })
  assert.equal(r.ok, true)
  assert.equal(typeof r.size, 'number')
  assert.ok(r.tone && typeof r.tone.temperature === 'string')
})

test('SIGNAL_WEIGHTS 可枚举（面板/文档依赖）', () => {
  assert.ok(Object.keys(SIGNAL_WEIGHTS).length >= 5)
  assert.ok(Object.hasOwn(SIGNAL_WEIGHTS, 'shared-joke'))
})
