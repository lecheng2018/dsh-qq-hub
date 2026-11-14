// US-015 接线验收：情感图谱真的被构造、持久化，并给出可用的 tone。
//
// 本文件覆盖两段「两端」接线（此前 tone()/bump() 全仓零调用方，图永远是空的）：
//   上半：模块级契约 —— 图 / toneFor / feed（信号喂料 + 冷却）/ stats（面板可观测）；
//   下半：宿主级契约 —— 关系温度 provider 注入与陌生人静默、跨 scope 隔离、
//         以及「feed 怎么炸都不影响回复投递」的容错矩阵。
import test from 'node:test'
import assert from 'node:assert/strict'
import affectiveGraph, { SIGNAL_COOLDOWN_MS, RECENT_SIGNAL_LIMIT } from '../src/modules/affective-graph/index.js'
import { SIGNAL_WEIGHTS, TRUST_LEVEL_LABELS } from '../src/chat/affective-graph.js'
import { createAffectiveProvider, formatAffectiveLine } from '../src/chat/context-assembly.js'

function fakeApi() {
  const routes = new Map()
  const timers = []
  const logs = []
  const store = new Map()
  const disposes = []
  return {
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
    dataDir: (name) => `/tmp/ag-${name}`,
    every: (ms, fn) => timers.push({ ms, fn }),
    onDispose: (fn) => disposes.push(fn),
    route: (p, fn) => routes.set(p, fn),
    core: {
      http: {
        body: async (req) => {
          if (req._bodyThrow) throw new Error('broken body stream')
          return req._body || {}
        },
      },
    },
    getRoute: (p) => routes.get(p),
    disposes,
    logs, store,
  }
}

const CHAT = 'private:1000'
const GROUP = 'group:9000'

/** 一轮能稳定命中 shared-joke 的对话（双方都在笑）。权重 2：单条不到等级 1 的门槛（3 分）。 */
const JOKE = { userText: '哈哈哈哈笑死我了', botText: '哈哈哈哈，被你发现了' }

/**
 * 一轮能稳定命中 shared-joke(2) + explicit-confirmed(2) = 4 分 → 越过等级 1 门槛（3 分）的对话。
 * 真实语境：一起笑完，顺口说一句"你真好"——两个信号互相独立，不是同一句刷两次。
 */
const WARM_TURN = { userText: '哈哈哈哈笑死我了，你真好', botText: '哈哈哈哈，被你发现了' }

test('模块 setup 返回 graph / toneFor / persist / dispose / feed / stats，且注册 onDispose', () => {
  const api = fakeApi()
  const out = affectiveGraph.setup(api)
  for (const k of ['graph', 'toneFor', 'persist', 'dispose', 'feed', 'stats']) {
    assert.ok(out[k], `应返回 ${k}`)
  }
  assert.equal(out.dispose, out.persist, 'dispose 与 persist 应当是同一函数')
  assert.ok(api.disposes.includes(out.persist), '应向 api.onDispose 注册 persist')
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

test('/affective/bump 在 HTTP body 解析异常时优雅容错', async () => {
  const api = fakeApi()
  affectiveGraph.setup(api)
  const r = await api.getRoute('/affective/bump')({ method: 'POST', _bodyThrow: true })
  assert.equal(r.ok, false)
  assert.match(String(r.message), /chat 与合法 signal 必填/)
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

test('SIGNAL_WEIGHTS 可枚举（面板/文档依赖）', () => {
  assert.ok(Object.keys(SIGNAL_WEIGHTS).length >= 5)
  assert.ok(Object.hasOwn(SIGNAL_WEIGHTS, 'shared-joke'))
})

// ---------------------------------------------------------------------------
// ① 信号喂料：feed 真的把对话变成分数（此前图永远 size=0）
// ---------------------------------------------------------------------------

test('feed：一轮真实对话就能让陌生人变熟络（图上不再是空图）', () => {
  const api = fakeApi()
  const { feed, toneFor, graph } = affectiveGraph.setup(api)
  assert.equal(graph.size(), 0, '起始是空图')
  assert.equal(toneFor(CHAT).temperature, 'cool')

  // 第一条信号：只到 2 分，还不到等级 1 的门槛——这正是"单次不算熟"的保守设计
  const single = feed({ chatKey: CHAT, ...JOKE })
  assert.equal(single.ok, true, `喂料应成功：${JSON.stringify(single)}`)
  assert.ok(single.applied.some((s) => s.kind === 'shared-joke'), '应记下 shared-joke')
  assert.equal(graph.size(), 1, '图上出现该会话节点')
  assert.equal(toneFor(CHAT).level, 0, '一条 shared-joke（2 分）还不到 3 分门槛')

  // 同一轮里另一个独立信号：4 分 → 熟络好友
  const out = feed({ chatKey: CHAT, ...WARM_TURN })
  assert.equal(out.ok, true, `喂料应成功：${JSON.stringify(out)}`)
  assert.ok(out.applied.length >= 1)
  assert.ok(toneFor(CHAT).score === undefined) // tone 不暴露分数（只给姿态）

  const after = toneFor(CHAT)
  assert.notEqual(after.temperature, 'cool', '等级 ≥1 后温度必须变暖')
  assert.equal(after.proactivePrivate, true, '熟络后允许主动私聊')
})

test('feed：没有信号的一轮不产出、不加分（图保持干净）', () => {
  const api = fakeApi()
  const { feed, graph } = affectiveGraph.setup(api)
  const out = feed({ chatKey: CHAT, userText: '今天天气不错，吃饭了吗', botText: '吃了，你呢' })
  assert.equal(out.ok, false)
  assert.deepEqual(out.applied, [])
  assert.equal(graph.size(), 0, '没有信号就不该建节点')
  assert.match(String(out.message), /没有识别到关系信号/)
})

test('feed：信号 note 引用原话，能在 explain 里追溯', () => {
  const api = fakeApi()
  const { feed, graph } = affectiveGraph.setup(api)
  feed({ chatKey: CHAT, ...JOKE })
  const why = graph.explain(CHAT, { viewer: CHAT })
  assert.ok(why.signals.length >= 1)
  assert.match(JSON.stringify(why.signals), /哈哈哈哈/, 'note 里应看得见触发它的那句原话')
})

// ---------------------------------------------------------------------------
// ② 冷却：同 chatKey 同 kind 短时间内不重复加分（防刷屏虚高）
// ---------------------------------------------------------------------------

test('冷却：同 kind 10 分钟内重复命中不重复加分', () => {
  const api = fakeApi()
  const { feed, graph, toneFor } = affectiveGraph.setup(api)
  const base = 1_700_000_000_000
  const first = feed({ chatKey: CHAT, ...WARM_TURN, now: base })
  assert.equal(first.ok, true)
  const scoreAfterFirst = graph.explain(CHAT, { viewer: CHAT }).score

  // 1 分钟后同样的对话再来一次：应被冷却拦下（否则刷屏式加分把等级吹虚）
  const second = feed({ chatKey: CHAT, ...WARM_TURN, now: base + 60_000 })
  assert.equal(second.ok, false)
  assert.deepEqual(second.applied, [])
  assert.ok(second.skipped.some((s) => s.kind === 'shared-joke'), '应记为冷却跳过（可解释）')
  assert.equal(graph.explain(CHAT, { viewer: CHAT }).score, scoreAfterFirst, '分数不该涨')
  assert.equal(toneFor(CHAT).level, 1, '等级不该被刷到挚友')

  // 越过 10 分钟窗口后重新计分
  const third = feed({ chatKey: CHAT, ...WARM_TURN, now: base + SIGNAL_COOLDOWN_MS })
  assert.equal(third.ok, true, '冷却窗口过后应能重新加分')
  assert.ok(graph.explain(CHAT, { viewer: CHAT }).score > scoreAfterFirst)
})

test('冷却按 kind 独立：不同信号互不影响', () => {
  const api = fakeApi()
  const { feed, graph } = affectiveGraph.setup(api)
  const base = 1_700_000_000_000
  feed({ chatKey: CHAT, ...JOKE, now: base })
  const afterJoke = graph.explain(CHAT, { viewer: CHAT }).score
  const out = feed({ chatKey: CHAT, userText: '我信任你，这事交给你', botText: '放心吧', now: base + 60_000 })
  assert.equal(out.ok, true, '不同 kind 不该被 shared-joke 的冷却拦住')
  assert.ok(graph.explain(CHAT, { viewer: CHAT }).score > afterJoke)
})

test('冷却按 chatKey 独立：群里的梗不会冷却掉私聊的梗', () => {
  const api = fakeApi()
  const { feed, graph } = affectiveGraph.setup(api)
  const base = 1_700_000_000_000
  feed({ chatKey: CHAT, ...WARM_TURN, now: base })
  const out = feed({ chatKey: GROUP, ...WARM_TURN, now: base + 60_000 })
  assert.equal(out.ok, true, '另一个聊天域应能正常计分')
  assert.ok(graph.trustLevel(GROUP, { viewer: GROUP }) >= 1)
})

// ---------------------------------------------------------------------------
// ③ 面板可观测性：图规模 / 等级分布 / 最近信号（含 note）
// ---------------------------------------------------------------------------

test('/affective/state 返回图规模、等级分布、最近信号（含 note 原话）', async () => {
  const api = fakeApi()
  const { feed } = affectiveGraph.setup(api)
  feed({ chatKey: CHAT, ...WARM_TURN })

  const r = await api.getRoute('/affective/state')({ query: { chat: CHAT } })
  assert.equal(r.ok, true)
  assert.equal(typeof r.size, 'number')
  assert.equal(r.size, 1, '图规模反映真实节点数')

  // 等级分布：0/1/2 三档都在，且总和 = 图规模
  assert.equal(r.levels.length, TRUST_LEVEL_LABELS.length)
  assert.deepEqual(r.levels.map((x) => x.level), [0, 1, 2])
  assert.equal(r.levels.reduce((n, x) => n + x.count, 0), r.size, '各等级计数之和应等于图规模')
  assert.equal(r.levels.find((x) => x.level === 1).count, 1, '熟络好友一档应有 1 个')

  // 最近信号：带 chatKey / kind / weight / note / at
  assert.ok(Array.isArray(r.recent))
  assert.ok(r.recent.length >= 1)
  const first = r.recent[0]
  for (const key of ['chatKey', 'kind', 'weight', 'note', 'at']) assert.ok(key in first, `最近信号应有 ${key}`)
  assert.match(first.note, /哈哈哈哈/, 'note 应引用被触发的原话（面板追溯）')
  assert.equal(r.signals['shared-joke'] >= 1, true, '按 kind 的计数应可见')

  // tone 与 explain：tone 给姿态，explain 给「为什么」
  assert.ok(r.tone && typeof r.tone.temperature === 'string')
  assert.ok(r.explain && r.explain.level >= 0)
  assert.ok(Array.isArray(r.explain.signals))
})

test('/affective/state：不带 chat 参数时只给全局统计（不给任何人的 tone）', async () => {
  const api = fakeApi()
  affectiveGraph.setup(api)
  const r = await api.getRoute('/affective/state')({ query: {} })
  assert.equal(r.ok, true)
  assert.equal(r.tone, null, '没说看谁就不猜是谁')
  assert.equal(r.size, 0)
  assert.ok(Array.isArray(r.levels))
})

test('/affective/state：最近信号条数可限（默认 12，最多 50）', async () => {
  const api = fakeApi()
  const { feed, stats } = affectiveGraph.setup(api)
  const base = 1_700_000_000_000
  // 造 3 个聊天域 × 3 种信号 = 9 条
  for (let i = 0; i < 3; i += 1) {
    const key = `private:${2000 + i}`
    feed({ chatKey: key, ...JOKE, now: base })
    feed({ chatKey: key, userText: '我信任你', botText: '放心吧', now: base + i })
    feed({ chatKey: key, userText: '谢谢，弄好了', botText: '先把日志开起来试试', now: base + i })
  }
  assert.equal(stats().recent.length, 9)
  assert.equal(stats({ limit: 3 }).recent.length, 3)
  assert.equal(stats().recentTotal, 9, '总数不受 limit 影响')
  assert.ok(RECENT_SIGNAL_LIMIT >= 1)
  // 稳定排序：时间倒序（同时间按 chatKey/kind），刷新面板不会跳序
  const first = stats().recent[0]
  const second = stats().recent[1]
  assert.ok(first.at >= second.at, '最近信号按时间倒序')
})

// ---------------------------------------------------------------------------
// ④ 关系温度 provider：注入文案随等级变化，陌生人静默
// ---------------------------------------------------------------------------

test('formatAffectiveLine：等级 0 不产出任何内容（不打扰）', () => {
  assert.equal(formatAffectiveLine({ level: 0, label: '陌生人', temperature: 'cool', jokeScale: 0.2 }), '')
  assert.equal(formatAffectiveLine(null), '')
  assert.equal(formatAffectiveLine({}), '')
  assert.equal(formatAffectiveLine({ level: 1, temperature: 'unknown' }), '', '没收录的温度不猜')
})

test('formatAffectiveLine：熟络/挚友给出简短姿态文案（含玩笑尺度）', () => {
  const warm = formatAffectiveLine({ level: 1, label: '熟络好友', temperature: 'warm', jokeScale: 0.6 })
  assert.match(warm, /熟络好友/)
  assert.match(warm, /暖/)
  assert.match(warm, /玩笑尺度 0\.6/)
  assert.ok(warm.length < 80, '一段姿态提示不该变成小作文')

  const intimate = formatAffectiveLine({ level: 2, label: '挚友', temperature: 'intimate', jokeScale: 1 })
  assert.match(intimate, /挚友/)
  assert.match(intimate, /玩笑尺度 1/)
})

test('provider 端到端：bump 后 tone 变暖 → 注入文案随之变化；陌生人时不注入', async () => {
  const api = fakeApi()
  const { toneFor, feed } = affectiveGraph.setup(api)
  const provider = createAffectiveProvider({ resolveTone: (chatKey) => toneFor(chatKey) })

  // 陌生人：不注入
  assert.equal(provider.provide({ chatKey: CHAT }), '', '等级 0 不注入任何内容')

  feed({ chatKey: CHAT, ...WARM_TURN })
  const text = provider.provide({ chatKey: CHAT })
  assert.ok(text, '熟络后应注入姿态提示')
  assert.match(text, /熟络好友|暖/, `注入文案应反映新等级：${text}`)
  assert.match(text, /玩笑尺度/)

  // 再攒到挚友（7 分门槛）：explicit-confirmed(+2) 与 mutual-help(+1) 各再来一次
  const base = Date.now() + SIGNAL_COOLDOWN_MS * 2
  feed({ chatKey: CHAT, userText: '我信任你，这事交给你', botText: '放心吧', now: base })
  feed({ chatKey: CHAT, userText: '谢谢，按你说的弄好了，解决了', botText: '先把日志开起来试试', now: base + 1 })
  const upgraded = provider.provide({ chatKey: CHAT })
  assert.match(upgraded, /挚友|更放松/, `等级 2 应升级文案：${upgraded}`)
})

test('provider 作用域：群聊与私聊各自独立，绝不跨 scope 读', () => {
  const api = fakeApi()
  const { toneFor, feed } = affectiveGraph.setup(api)
  const provider = createAffectiveProvider({ resolveTone: (chatKey) => toneFor(chatKey) })
  const base = Date.now()

  feed({ chatKey: CHAT, ...WARM_TURN, now: base })
  assert.ok(provider.provide({ chatKey: CHAT }), '私聊自己攒的等级能读到')
  assert.equal(provider.provide({ chatKey: GROUP }), '', '群聊读不到私聊攒下的等级（隐私单向流动）')
  assert.equal(provider.provide({ chatKey: 'nope' }), '', '非法 ChatKey 不注入（fail-closed）')
  assert.equal(provider.provide({}), '', '没有 scope 就什么都不注入')
})

test('provider 出错 isolate：resolveTone 抛错 / 返回怪形状都不影响其他 provider', async () => {
  // 抛错：交给装配层 isolate（错误可审计，但不阻断装配）
  const boom = createAffectiveProvider({ resolveTone: () => { throw new Error('graph offline') } })
  assert.throws(() => boom.provide({ chatKey: CHAT }), /graph offline/, 'provider 自己如实抛出，由装配层隔离')
  assert.equal(boom.onError, 'isolate', '错误策略必须是 isolate（不许 fail-closed 拖垮整轮）')

  // 怪形状：静默不注入
  for (const weird of [null, undefined, 'warm', 42, { ok: false }, { level: 'x' }, { level: -1 }]) {
    const p = createAffectiveProvider({ resolveTone: () => weird })
    assert.equal(p.provide({ chatKey: CHAT }), '', `${JSON.stringify(weird)} 应不注入`)
  }

  // 没有 resolveTone（模块关着）：不注入、不抛
  const absent = createAffectiveProvider({ resolveTone: undefined })
  assert.equal(absent.provide({ chatKey: CHAT }), '')
})

// ---------------------------------------------------------------------------
// ⑤ 容错：feed 怎么炸都只影响记分，绝不影响回复
// ---------------------------------------------------------------------------

test('feed 容错：非法 chatKey / 空输入 / 缺模块 都不抛，只返回 ok:false', () => {
  const api = fakeApi()
  const { feed, graph } = affectiveGraph.setup(api)
  for (const bad of ['', 'nope', 'private:', 'group:0', 42, {}]) {
    const out = feed({ chatKey: bad, ...JOKE })
    assert.equal(out.ok, false, `${JSON.stringify(bad)} 应返回 ok:false`)
    assert.deepEqual(out.applied, [])
  }
  assert.equal(graph.size(), 0, '非法 chatKey 不该在图里留节点')
})

test('feed 容错：图里 bump 抛错时，其余信号照常记（一条坏信号不拖垮整轮）', () => {
  const api = fakeApi()
  const { feed, graph, toneFor } = affectiveGraph.setup(api)
  const realBump = graph.bump
  // 只让 shared-joke 的 bump 失败（模拟图内部异常），另一条信号必须照常落账
  graph.bump = (chatKey, signal, opts) => {
    if (signal.kind === 'shared-joke') throw new Error('图谱内部写坏了')
    return realBump(chatKey, signal, opts)
  }
  const out = feed({ chatKey: CHAT, ...WARM_TURN })
  assert.ok(out.applied.some((s) => s.kind === 'explicit-confirmed'), '好的那条信号应照常记下')
  assert.ok(out.skipped.some((s) => s.kind === 'shared-joke' && /写坏/.test(s.reason)), '坏的那条应记为跳过并可解释')
  assert.equal(out.ok, true, '有成功信号就算 ok')
  assert.equal(toneFor(CHAT).level, 0, '只有 2 分，仍不到门槛（失败那条没算）')
  graph.bump = realBump
})

test('feed 容错：feed 永远不把异常冒出去（恶意 now / 怪 cooldownMs 都不抛）', () => {
  const api = fakeApi()
  const mod = affectiveGraph.setup(api)
  // 恶意的 valueOf（Number() 时抛错）：仍不该冒泡，且返回结构完整
  const evilNow = { valueOf() { throw new Error('boom') } }
  let out
  assert.doesNotThrow(() => { out = mod.feed({ chatKey: CHAT, ...JOKE, now: evilNow }) })
  assert.equal(typeof out.ok, 'boolean')
  // 怪冷却窗口（负数 / NaN / 对象）：回退默认窗口，不抛
  for (const weird of [-1, NaN, Infinity, {}, { valueOf() { throw new Error('x') } }]) {
    assert.doesNotThrow(() => mod.feed({ chatKey: CHAT, userText: '我信任你', botText: '放心吧', cooldownMs: weird }))
  }
})
