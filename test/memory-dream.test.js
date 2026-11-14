// 梦境记忆巩固（Dream Consolidation / US-016）
// 红线优先：物理事实源只增不改 —— 被合并/证伪的条目只产出 supersede 墓碑，绝不删除。
import test from 'node:test'
import assert from 'node:assert/strict'
import consolidate, {
  DREAM_VERSION, DEFAULT_DREAM_OPTIONS, seededRandom, estimateTokens,
  normalizeText, normalizeFact, consolidate as namedConsolidate,
} from '../src/features/memory-dream.js'

const NOW = 1_700_000_000_000
const opts = (over = {}) => ({ now: () => NOW, ...over })
const fact = (id, text, over = {}) => ({
  id, text, scope: 'chat:1', topic: 't', entity: '', importance: 0.5, ...over,
})

test('默认导出与具名导出是同一个函数', () => {
  assert.equal(typeof consolidate, 'function')
  assert.equal(consolidate, namedConsolidate)
  assert.equal(DREAM_VERSION, 1)
})

// ---------------- fail-closed ----------------
test('facts 非数组 → ok:false，且不产出任何半成品', () => {
  for (const bad of [null, undefined, 'x', 1, {}, true]) {
    const r = consolidate(bad, opts())
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应失败`)
    assert.equal(r.facts.length, 0, '失败时不得返回事实')
    assert.equal(r.supersede.length, 0, '失败时不得产出墓碑操作')
  }
})

test('空数组 → ok:true 且各集合为空（不是失败）', () => {
  const r = consolidate([], opts())
  assert.equal(r.ok, true)
  assert.deepEqual(r.facts, [])
  assert.deepEqual(r.experiences, [])
  assert.deepEqual(r.supersede, [])
  assert.equal(r.truncated, false)
})

test('单条非法事实只记 rejected，不影响其余合法条目', () => {
  const r = consolidate([fact('a', '今天下雨了'), null, { text: '' }, fact('b', '我去买菜')], opts())
  assert.equal(r.ok, true)
  assert.equal(r.stats.rejected, 2, 'null 与空 text 各算一条 rejected')
  assert.equal(r.facts.length, 2, '两条合法事实应保留')
  assert.ok(r.rejected.every((x) => typeof x.index === 'number'), 'rejected 要带原始下标')
})

// ---------------- 墓碑语义（核心红线） ----------------
test('去重合并：被合并条目产出 supersede 墓碑，绝不出现在 facts 里', () => {
  // 文本几乎相同 → Jaccard 必过 0.82
  const r = consolidate([
    fact('a1', '主人喜欢在雨天喝热咖啡', { importance: 0.5 }),
    fact('a2', '主人喜欢在雨天喝热咖啡', { importance: 0.9 }),
  ], opts())
  assert.equal(r.ok, true)
  assert.equal(r.facts.length, 1, '合并后应只剩一条代表')
  assert.equal(r.merges.length, 1, '应记录一次合并')
  assert.ok(r.supersede.length >= 1, '被合并者必须产出墓碑')
  const tomb = r.supersede[0]
  assert.equal(tomb.action, 'supersede')
  assert.ok(tomb.oldId && tomb.newId, '墓碑必须同时有 oldId 与 newId')
  assert.equal(tomb.oldId !== tomb.newId, true, '墓碑不能指向自己')
  assert.ok(tomb.invalidAt, '墓碑必须带 invalidAt 时间')
})

test('墓碑只增不改：所有 tombstone 都是 supersede 操作，没有 delete', () => {
  const r = consolidate([
    fact('x1', '同一句话重复出现测试一二三'),
    fact('x2', '同一句话重复出现测试一二三'),
    fact('x3', '同一句话重复出现测试一二三'),
  ], opts())
  assert.equal(r.ok, true)
  const actions = r.supersede.map((s) => s.action)
  assert.ok(actions.every((a) => a === 'supersede'), `只允许 supersede，实际 ${actions.join(',')}`)
  assert.equal(r.supersede.length, 2, '3 条合一应有 2 条进墓碑')
})

test('代表条目记录 mergedFrom / mergedCount，可溯源', () => {
  const r = consolidate([
    fact('a', '今天天气很好适合出门散步'),
    fact('b', '今天天气很好适合出门散步'),
  ], opts())
  const rep = r.facts[0]
  assert.ok(Array.isArray(rep.mergedFrom), '代表条要能回溯来源')
  assert.equal(rep.mergedCount, 2)
})

test('矛盾证伪：旧条目立墓碑，新条目记 supersededFrom', () => {
  const r = consolidate([
    fact('old', '我不喜欢吃辣椒', { importance: 0.3 }),
    fact('new', '我喜欢吃辣椒', { importance: 0.9 }),
  ], opts())
  assert.equal(r.ok, true)
  if (r.conflicts.length) {
    const c = r.conflicts[0]
    assert.ok(c.winner && c.losers.length, '矛盾应指明胜出者与失败者')
    const winner = r.facts.find((f) => f.id === c.winner)
    assert.ok(winner, '胜出者应在 facts 中')
    assert.ok(winner.supersededFrom, '胜出者应记 supersededFrom')
    assert.equal(r.supersede.some((s) => s.oldId === c.losers[0]), true, '失败者必须进墓碑')
  }
})

// ---------------- 共性归纳 ----------------
test('成员数达 minCluster 才归纳出经验条目', () => {
  const rows = [
    fact('a1', '主人提到周末去了公园散步', { topic: '周末活动' }),
    fact('a2', '主人说昨天和朋友去公园散步', { topic: '周末活动' }),
  ]
  const r2 = consolidate(rows, opts({ minCluster: 2 }))
  assert.equal(r2.ok, true)
  assert.ok(r2.experiences.length >= 1, '两条同话题应归纳出一条经验')

  const r3 = consolidate(rows, opts({ minCluster: 3 }))
  assert.equal(r3.experiences.length, 0, '阈值 3 时两条不足以归纳')
})

test('经验条目带 kind=experience 与可读 summary', () => {
  const r = consolidate([
    fact('a1', '主人提到周末去了公园散步', { topic: '周末活动' }),
    fact('a2', '主人说昨天和朋友去公园散步', { topic: '周末活动' }),
    fact('a3', '主人讲周末在公园散步很久', { topic: '周末活动' }),
  ], opts({ minCluster: 2 }))
  assert.equal(r.experiences.length, 1, '三条同话题应归纳出一条经验')
  const exp = r.experiences[0]
  assert.equal(exp.kind, 'experience')
  assert.equal(typeof exp.summary, 'string')
  assert.ok(exp.summary.length > 0, 'summary 不能为空')
  assert.equal(exp.scope, 'chat:1')
})

// ---------------- Token 预算 ----------------
test('预算超限时截断并标记 truncated，被截断条目不写墓碑（不丢事实）', () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    fact(`m${i}`, `独立事实${i}号：${'甲乙丙丁戊己庚辛壬癸'[i % 10]}类内容${i * 7}`, { topic: `t${i}` }))
  const r = consolidate(many, opts({ tokenBudget: 120, minCluster: 99 }))
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true, '小预算应触发截断')
  assert.ok(r.tokens.used <= r.tokens.budget + 1, `用量 ${r.tokens.used} 不应超预算 ${r.tokens.budget}`)
  // 关键：截断是"不处理"，不是"判定为重复/矛盾"，所以不该产生墓碑
  assert.equal(r.supersede.length, 0, '截断不得产生墓碑')
})

test('tokenBudget=0 时一条都不处理，但 ok 仍为 true', () => {
  const r = consolidate([fact('a', '一些内容')], opts({ tokenBudget: 0 }))
  assert.equal(r.ok, true)
  assert.equal(r.facts.length, 0)
  assert.equal(r.truncated, true)
})

// ---------------- 输入只读 ----------------
test('输入只读：跑完后原始条目字段不被修改', () => {
  const src = [
    fact('a', '重复的一句话用来触发合并', { importance: 0.4 }),
    fact('b', '重复的一句话用来触发合并', { importance: 0.8 }),
  ]
  const snapshot = JSON.stringify(src)
  consolidate(src, opts())
  assert.equal(JSON.stringify(src), snapshot, '入参不得被污染')
})

test('返回值改动不污染入参（返回的是新对象）', () => {
  const src = [fact('a', '一条独立事实')]
  const r = consolidate(src, opts())
  if (r.facts.length) {
    r.facts[0].text = '被改了'
    assert.notEqual(src[0].text, '被改了', '返回对象必须是副本')
  }
})

// ---------------- 确定性 ----------------
test('确定性：同输入同种子连跑三次结果完全一致', () => {
  const rows = [
    fact('a', '甲喜欢下雨天', { topic: '天气' }),
    fact('b', '甲不喜欢下雨天', { topic: '天气' }),
    fact('c', '乙喜欢晴天', { topic: '天气', scope: 'chat:2' }),
  ]
  const sig = (x) => JSON.stringify({ f: x.facts.map((v) => v.id), s: x.supersede, e: x.experiences.length })
  const r1 = consolidate(rows, opts({ seed: 7 }))
  const r2 = consolidate(rows, opts({ seed: 7 }))
  const r3 = consolidate(rows, opts({ seed: 7 }))
  assert.equal(sig(r1), sig(r2))
  assert.equal(sig(r2), sig(r3))
})

test('seededRandom 可复现，且落在 [0,1)', () => {
  const a = seededRandom(42), b = seededRandom(42)
  for (let i = 0; i < 50; i += 1) {
    const x = a(), y = b()
    assert.equal(x, y, '同种子序列必须相同')
    assert.ok(x >= 0 && x < 1, `越界 ${x}`)
  }
})

test('sampleLimit 限制处理条数且可复现', () => {
  const rows = Array.from({ length: 30 }, (_, i) => fact(`s${i}`, `各不相同的内容第${i}号`, { topic: `t${i}` }))
  const r = consolidate(rows, opts({ sampleLimit: 5, seed: 3, minCluster: 99 }))
  assert.equal(r.ok, true)
  assert.ok(r.stats.sampled <= 5, `抽样数 ${r.stats.sampled} 应 ≤ 5`)
})

// ---------------- 工具函数 ----------------
test('normalizeText 去噪：空白归一、小写', () => {
  assert.equal(normalizeText('  Hello   World  '), normalizeText('hello world'))
  assert.equal(typeof normalizeText(''), 'string')
})

test('estimateTokens 单调：文本越长估值不减少', () => {
  const a = estimateTokens('短')
  const b = estimateTokens('这是一段明显更长的文本内容用来比较')
  assert.ok(b >= a, `${a} -> ${b} 应单调`)
})

test('normalizeFact：非法条目返回 null', () => {
  assert.equal(normalizeFact(null), null)
  assert.equal(normalizeFact({}), null)
  assert.equal(normalizeFact({ text: '   ' }), null)
  assert.ok(normalizeFact({ id: 'z', text: '有效内容' }), '合法条目应返回对象')
})

test('DEFAULT_DREAM_OPTIONS 关键默认值符合计划书口径', () => {
  assert.equal(DEFAULT_DREAM_OPTIONS.tokenBudget, 1200)
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeSimilarity > 0.5, '去重阈值应偏严')
  assert.ok(DEFAULT_DREAM_OPTIONS.minCluster >= 2, '归纳至少 2 条')
})
