// P4 · 信任矩阵与专属梗词表（affective-graph）回归。
// 这一层决定「她跟谁有多熟」，所以三条铁律必须有测试盯着：
//   ① 等级跃迁只由可解释信号推动，不许随机；
//   ② 私聊里攒下的等级与梗，群 scope 一律读不到，越界就抛错；
//   ③ 空图默认陌生人（不主动私聊），坏数据 fail-closed 回退 0。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAffectiveGraph,
  levelFromScore,
  levelLabel,
  normalizeJoke,
  normalizeLevel,
  AffectiveScopeError,
  DEFAULT_LEVEL,
  LEVEL_THRESHOLDS,
  SIGNAL_WEIGHTS,
} from '../src/chat/affective-graph.js'

const PRIVATE_A = 'private:10001'
const GROUP_A = 'group:20001'

function makeGraph(start = 1_700_000_000_000) {
  let t = start
  const graph = createAffectiveGraph({ now: () => t })
  return { graph, tick: (ms) => { t += ms }, set: (ms) => { t = ms } }
}

test('空图默认等级 0（陌生人，不主动私聊）', () => {
  const { graph } = makeGraph()
  assert.equal(graph.trustLevel(PRIVATE_A), DEFAULT_LEVEL)
  assert.equal(graph.trustLevel(GROUP_A), DEFAULT_LEVEL)
  const tone = graph.tone(PRIVATE_A)
  assert.equal(tone.level, 0)
  assert.equal(tone.label, '陌生人')
  assert.equal(tone.proactivePrivate, false)
  assert.deepEqual(graph.listJokes(PRIVATE_A), [])
  // 只读不改：读一遍不该凭空建出节点
  assert.equal(graph.size(), 0)
})

test('等级只由可解释信号推动：0 → 1 → 2，并留下信号账本', () => {
  const { graph } = makeGraph()
  assert.equal(graph.bump(PRIVATE_A, { kind: 'deep-talk', note: '第一次掏心窝' }).level, 0)
  assert.equal(graph.trustLevel(PRIVATE_A), 0, '1 分不够，不许跳级')
  assert.equal(graph.bump(PRIVATE_A, { kind: 'deep-talk', note: '又聊到凌晨' }).level, 0, '2 分仍不够')

  const third = graph.bump(PRIVATE_A, { kind: 'deep-talk', note: '第三天继续' })
  assert.equal(third.level, 1, '3 分刚好熟络好友')
  assert.equal(third.changed, true)
  assert.equal(third.previousLevel, 0)

  graph.bump(PRIVATE_A, { kind: 'shared-joke', note: '对上了暗号' })
  assert.equal(graph.trustLevel(PRIVATE_A), 1, '5 分还没到挚友门槛')
  graph.bump(PRIVATE_A, { kind: 'mutual-help', note: '帮她修好了路由器' })
  graph.bump(PRIVATE_A, { kind: 'mutual-help', note: '她帮我带了饭' })
  assert.equal(graph.trustLevel(PRIVATE_A), 2, '7 分进挚友')

  const view = graph.explain(PRIVATE_A)
  assert.equal(view.level, 2)
  assert.equal(view.label, '挚友')
  assert.equal(view.signals.length, 6, '每一条信号都要能解释出来')
  assert.equal(view.signals[0].kind, 'deep-talk')
  assert.equal(view.signals[0].note, '第一次掏心窝')
  assert.equal(view.score, 7)
  assert.equal(view.reason, '她帮我带了饭')
})

test('未知信号一律拒收（fail-closed），分数与等级都不动', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.bump(PRIVATE_A, { kind: 'vibes' }), /未知信号/)
  assert.throws(() => graph.bump(PRIVATE_A, { kind: '' }), TypeError)
  assert.throws(() => graph.bump(PRIVATE_A, null), TypeError)
  assert.equal(graph.trustLevel(PRIVATE_A), 0)
  assert.equal(graph.explain(PRIVATE_A).score, 0)
})

test('负面信号能降级，衰减让长期不联系的关系自然变远', () => {
  const { graph, tick } = makeGraph()
  for (const [kind, note] of [['deep-talk', 'a'], ['deep-talk', 'b'], ['shared-joke', 'c'], ['shared-joke', 'd'], ['mutual-help', 'e']]) {
    graph.bump(PRIVATE_A, { kind, note })
  }
  assert.equal(graph.trustLevel(PRIVATE_A), 2, '1+1+2+2+1 = 7 分，挚友')
  const hit = graph.bump(PRIVATE_A, { kind: 'boundary-violation', note: '翻了她的私信' })
  assert.equal(hit.level, 1, '挚友 7 分 − 3 分 = 4 分，掉回熟络好友')
  assert.equal(hit.changed, true)
  assert.equal(hit.score, 4)

  // 再吵一次就掉回陌生人（1 分 < 3 分门槛）
  const again = graph.bump(PRIVATE_A, { kind: 'conflict', note: '为同一个梗吵翻' })
  assert.equal(again.level, 0, '1 分不够熟络，退回陌生人')
  assert.equal(graph.tone(PRIVATE_A).proactivePrivate, false, '退回陌生人后不再主动私聊')
})

test('闲置衰减：每 14 天掉 1 分，等级跟着回落，最低 0', () => {
  const { graph, tick } = makeGraph()
  graph.bump(PRIVATE_A, { kind: 'shared-joke', note: 'x' })
  graph.bump(PRIVATE_A, { kind: 'shared-joke', note: 'y' })
  assert.equal(graph.trustLevel(PRIVATE_A), 1)
  const same = graph.decay(PRIVATE_A)
  assert.equal(same.decayed, 0, '没到周期不衰减')

  tick(14 * 86_400_000)
  const once = graph.decay(PRIVATE_A)
  assert.equal(once.decayed, 1)
  assert.equal(once.score, 3)
  assert.equal(once.level, 1, '3 分还在熟络好友')

  tick(60 * 86_400_000)
  const long = graph.decay(PRIVATE_A)
  assert.equal(long.level, 0, '闲置太久必须掉回陌生人')
  assert.equal(long.score, 0, '分数不会掉成负数')
  assert.equal(graph.decay(PRIVATE_A).decayed, 0, '同一时间点重复调用不重复扣分')
})

test('非法等级回退陌生人，不抛错也不建立第二套规则', () => {
  const { graph } = makeGraph()
  graph.bump(PRIVATE_A, { kind: 'deep-talk', note: 'a' })
  graph.bump(PRIVATE_A, { kind: 'deep-talk', note: 'b' })
  graph.bump(PRIVATE_A, { kind: 'deep-talk', note: 'c' })
  assert.equal(graph.trustLevel(PRIVATE_A), 1)

  for (const bad of [-1, 3, 1.5, '2', null, undefined, NaN, Infinity, {}]) {
    const r = graph.setLevel(PRIVATE_A, bad)
    assert.equal(r.ok, false, `非法等级 ${String(bad)} 必须被拒`)
    assert.equal(r.level, DEFAULT_LEVEL)
    assert.equal(graph.trustLevel(PRIVATE_A), DEFAULT_LEVEL)
  }

  const ok = graph.setLevel(PRIVATE_A, 2)
  assert.equal(ok.ok, true)
  assert.equal(graph.trustLevel(PRIVATE_A), 2)
  assert.equal(normalizeLevel(2), 2)
  assert.equal(normalizeLevel(-1), null)
  assert.equal(normalizeLevel(2.5), null)
  assert.equal(levelLabel(99), '陌生人')
})

test('等级语义查表：0/1/2 对应陌生人/熟络好友/挚友', () => {
  assert.deepEqual([0, 1, 2].map(levelLabel), ['陌生人', '熟络好友', '挚友'])
  assert.equal(levelFromScore(0), 0)
  assert.equal(levelFromScore(LEVEL_THRESHOLDS[1]), 1)
  assert.equal(levelFromScore(LEVEL_THRESHOLDS[2]), 2)
  assert.equal(levelFromScore(999), 2)
  assert.equal(levelFromScore(-50), 0)
  assert.equal(levelFromScore('乱七八糟'), 0)
  // 阈值单调递增：不许出现低分高等级的倒挂
  assert.ok(LEVEL_THRESHOLDS[0] < LEVEL_THRESHOLDS[1])
  assert.ok(LEVEL_THRESHOLDS[1] < LEVEL_THRESHOLDS[2])
  assert.ok(SIGNAL_WEIGHTS['shared-joke'] > 0 && SIGNAL_WEIGHTS['boundary-violation'] < 0)
})

test('梗词表：同 scope 去重（空白/大小写归一），空梗不收', () => {
  const { graph } = makeGraph()
  const first = graph.addJoke(PRIVATE_A, '  菠萝披萨   不能接受  ')
  assert.equal(first.ok, true)
  assert.equal(first.added, true)
  assert.equal(first.joke.text, '菠萝披萨 不能接受')

  const dup = graph.addJoke(PRIVATE_A, '菠萝披萨  不能接受')
  assert.equal(dup.ok, true)
  assert.equal(dup.added, false, '只差空格，算同一个梗')
  assert.equal(dup.reason, '已存在（去重）')

  const dupCase = graph.addJoke(PRIVATE_A, 'HTTP 418 是茶壶')
  assert.equal(dupCase.added, true)
  assert.equal(graph.addJoke(PRIVATE_A, 'http 418   是茶壶').added, false, '拉丁字母大小写折叠后同一个梗')

  assert.equal(graph.addJoke(PRIVATE_A, '   ').ok, false)
  assert.equal(graph.addJoke(PRIVATE_A, null).ok, false)

  const list = graph.listJokes(PRIVATE_A)
  assert.equal(list.length, 2)
  assert.equal(normalizeJoke('  A  B '), 'a b')
})

test('隐私隔离：private 的等级与梗，group scope 读不到、越界即抛错', () => {
  const { graph } = makeGraph()
  const OWNER_PRIVATE = 'private:10001'
  const SAME_GUY_GROUP = 'group:10001'
  graph.bump(OWNER_PRIVATE, { kind: 'shared-joke', note: '只有我俩懂的梗' }, { viewer: OWNER_PRIVATE })
  graph.addJoke(OWNER_PRIVATE, '半夜三点的泡面仪式', { viewer: OWNER_PRIVATE })
  assert.equal(graph.listJokes(OWNER_PRIVATE).length, 1)

  // 同一个人的群会话（uid 相同）绝不能顺着 uid 摸到私聊数据
  assert.throws(() => graph.trustLevel(SAME_GUY_GROUP), AffectiveScopeError)
  assert.throws(() => graph.listJokes(SAME_GUY_GROUP), AffectiveScopeError)
  assert.throws(() => graph.explain(SAME_GUY_GROUP), AffectiveScopeError)
  assert.throws(() => graph.tone(SAME_GUY_GROUP), AffectiveScopeError)
  assert.throws(() => graph.bump(SAME_GUY_GROUP, { kind: 'deep-talk' }), AffectiveScopeError)
  assert.throws(() => graph.addJoke(SAME_GUY_GROUP, '群里的梗'), AffectiveScopeError)

  // 显式 viewer：哪怕用别的键名，群会话也不可能读到私聊节点
  const GROUP_ELSE = 'group:20001'
  assert.throws(() => graph.trustLevel(OWNER_PRIVATE, { viewer: GROUP_ELSE }), AffectiveScopeError)
  assert.throws(() => graph.listJokes(OWNER_PRIVATE, { viewer: GROUP_ELSE }), AffectiveScopeError)
  assert.throws(() => graph.bump(OWNER_PRIVATE, { kind: 'deep-talk' }, { viewer: GROUP_ELSE }), AffectiveScopeError)
  assert.throws(() => graph.addJoke(OWNER_PRIVATE, 'x', { viewer: GROUP_ELSE }), AffectiveScopeError)

  try {
    graph.trustLevel(OWNER_PRIVATE, { viewer: GROUP_ELSE })
    assert.fail('应该抛错')
  } catch (e) {
    assert.equal(e.code, 'E_SCOPE_ISOLATION')
    assert.equal(e.name, 'AffectiveScopeError')
    assert.equal(e.scope, GROUP_ELSE)
    assert.equal(e.ownerScope, 'private')
  }

  // 计划书允许的方向：群里公开的梗 → 私聊可以读（单向流动，不是双向）
  const GROUP_PUBLIC = 'group:30001'
  graph.addJoke(GROUP_PUBLIC, '群里的名场面', { viewer: GROUP_PUBLIC })
  assert.equal(graph.listJokes(GROUP_PUBLIC).length, 1)
  assert.equal(graph.listJokes(GROUP_PUBLIC, { viewer: OWNER_PRIVATE }).length, 1)
  // 撞号时也允许这个方向（声明 viewer 后按方向判定，不再拿 uid 撞车一刀切）
  assert.equal(graph.listJokes(SAME_GUY_GROUP, { viewer: OWNER_PRIVATE }).length, 0)

  // 其它用户的私聊不受影响，也不会串味
  assert.equal(graph.trustLevel('private:10002'), 0)
  assert.deepEqual(graph.listJokes('private:10002'), [])
})
test('非法 ChatKey 抛 TypeError，绝不猜键', () => {
  const { graph } = makeGraph()
  for (const bad of ['', '10001', 'private:', 'group:abc', null, undefined, 'private:001']) {
    assert.throws(() => graph.trustLevel(bad), TypeError, `非法键 ${String(bad)} 必须抛 TypeError`)
  }
})

test('快照往返确定性：两次 toJSON 完全一致，坏节点跳过、坏等级回退 0', () => {
  const { graph } = makeGraph()
  graph.bump(PRIVATE_A, { kind: 'shared-joke', note: '对暗号' })
  graph.addJoke(PRIVATE_A, '对暗号', { tags: ['内部'] })

  const a = JSON.stringify(graph.toJSON())
  const b = JSON.stringify(graph.toJSON())
  assert.equal(a, b, '同一状态必须序列化出同一份字节')

  const snap = JSON.parse(a)
  assert.equal(snap.nodes.length, 1)
  assert.equal(snap.nodes[0].scope, 'private')

  const restored = createAffectiveGraph({ now: () => 1_700_000_000_000 })
  const stats = restored.load(snap)
  assert.deepEqual(stats, { loaded: 1, skipped: 0 })
  assert.equal(restored.trustLevel(PRIVATE_A), 0)
  assert.equal(restored.listJokes(PRIVATE_A).length, 1)
  assert.equal(JSON.stringify(restored.toJSON()), a, '往返后字节仍一致')

  const dirty = createAffectiveGraph()
  const dirtyStats = dirty.load({
    nodes: [
      { chatKey: 'private:10001', level: 7, score: 12 },
      { chatKey: 'garbage', level: 2 },
      { level: 2 },
      null,
    ],
  })
  assert.equal(dirtyStats.loaded, 1)
  assert.equal(dirtyStats.skipped, 3)
  assert.equal(dirty.trustLevel('private:10001'), 0, '快照里 level=7 是非法值，回退陌生人')
  assert.equal(dirty.load({ nope: true }).loaded, 0)
})

test('回复姿态随等级变化：温度与玩笑尺度递增', () => {
  const { graph } = makeGraph()
  assert.equal(graph.tone(PRIVATE_A).temperature, 'cool')
  graph.bump(PRIVATE_A, { kind: 'deep-talk' })
  graph.bump(PRIVATE_A, { kind: 'deep-talk' })
  graph.bump(PRIVATE_A, { kind: 'deep-talk' })
  const warm = graph.tone(PRIVATE_A)
  assert.equal(warm.level, 1)
  assert.equal(warm.temperature, 'warm')
  assert.ok(warm.jokeScale > 0.2)
  graph.bump(PRIVATE_A, { kind: 'shared-joke' })
  graph.bump(PRIVATE_A, { kind: 'shared-joke' })
  const close = graph.tone(PRIVATE_A)
  assert.equal(close.level, 2)
  assert.equal(close.temperature, 'intimate')
  assert.ok(close.jokeScale >= warm.jokeScale)
})

test('边界：负分不设下限但等级钉在 0，时间倒流不产生反向衰减', () => {
  const { graph, set } = makeGraph()
  for (const kind of ['conflict', 'boundary-violation', 'conflict']) graph.bump(PRIVATE_A, { kind, note: '连环翻车' })
  const view = graph.explain(PRIVATE_A)
  assert.equal(view.level, 0, '再怎么扣也还是陌生人，不会出现负数等级')
  assert.ok(view.score < 0, '分数可以负，作为「有前科」的痕迹留着')
  assert.equal(levelFromScore(view.score), 0)

  graph.bump('private:10003', { kind: 'shared-joke' })
  set(5_000)
  graph.decay('private:10003')
  const backwards = graph.decay('private:10003', 0)
  assert.equal(backwards.decayed, 0, '时间戳比游标还早时不许扣分')
  assert.equal(backwards.score, 2)
})

test('撞号 fail-closed：同号 uid 已在别的 scope 有节点时，不声明 viewer 一律拒绝', () => {
  const { graph } = makeGraph()
  graph.bump(PRIVATE_A, { kind: 'deep-talk' }, { viewer: PRIVATE_A })
  // 'group:10001' 与 'private:10001' 同号：默认拒绝（分不清是同一个人还是撞号）
  assert.throws(() => graph.trustLevel('group:10001'), AffectiveScopeError)
  // 声明 viewer 就是自己 → 允许（空节点，等级 0），但拿不到私聊内容
  const selfView = graph.trustLevel('group:10001', { viewer: 'group:10001' })
  assert.equal(selfView, 0)
  assert.deepEqual(graph.listJokes('group:10001', { viewer: 'group:10001' }), [])
  assert.equal(graph.trustLevel(PRIVATE_A), 0)
  assert.equal(graph.listJokes(PRIVATE_A).length, 0)
})
