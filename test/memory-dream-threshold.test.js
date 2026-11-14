// 缺陷 B 回归：梦境默认去重阈值对真实中文改写太严（0.82 → 一条都不并）。
//
// 实测事实（本文件就是证据）：
//   · 同一件事的两种说法「主人下雨天喜欢呆在家里看书」/「下雨天主人最喜欢呆在家里面看书」
//     原串二元字组 Jaccard 只有 0.529，归一词后 0.563 —— 旧默认 0.82 永远合不了；
//   · 但**单靠降阈值必然误并**：猫/狗 0.636、3月5日/3月6日 0.600 都比这条改写更高。
//     所以修复不是「把 0.82 改成 0.7」，而是两级判定 + 三道闸门（见 memory-dream.js）。
//
// 这个文件用真实中文样本断言两件事，缺一不可：
//   ① 真实改写会被合并（否则缺陷没修好）；
//   ② 红线样本绝不被误并（否则修坏了 —— 比不修更糟）。
import test from 'node:test'
import assert from 'node:assert/strict'
import consolidate, { DEFAULT_DREAM_OPTIONS } from '../src/features/memory-dream.js'

const NOW = 1_700_000_000_000
const opts = (over = {}) => ({ now: () => NOW, minCluster: 99, ...over })

/** 同作用域、同槽位的两条事实；返回 consolidate 结果。 */
function pair(a, b, over = {}) {
  return consolidate([
    { id: 'A', text: a, scope: 'private:10001', importance: 0.4, at: 1, topic: 't' },
    { id: 'B', text: b, scope: 'private:10001', importance: 0.9, at: 2, topic: 't' },
  ], opts(over))
}

/** 「这两条被当成同一件事合并了」——代表条目吸收了另一条。 */
const merged = (r) => r.merges.length > 0 && r.supersede.length > 0

// ---------------- ① 真实改写必须被合并（缺陷 B 的正题） ----------------
const REAL_PARAPHRASES = [
  ['主人下雨天喜欢呆在家里看书', '下雨天主人最喜欢呆在家里面看书'],
  ['主人喜欢在雨天喝热咖啡', '主人喜欢在雨天喝热咖啡'],
  ['主人住在上海浦东', '主人住在上海的浦东'],
  ['阿强喜欢钓鱼', '阿强喜欢钓鱼呀'],
  ['主人喜欢喝咖啡', '主人喜欢喝咖啡的'],
  ['同一句话重复出现测试一二三', '同一句话重复出现测试一二三'],
  ['事实A', '事实A。'],
]

test('默认参数就能合并真实中文改写（旧默认 0.82 时 merges=0）', () => {
  for (const [a, b] of REAL_PARAPHRASES) {
    const r = pair(a, b)
    assert.equal(r.ok, true, `${a} <> ${b}`)
    assert.equal(r.facts.length, 1, `应合并成 1 条代表：${a} <> ${b}，实际 ${r.facts.length}`)
    assert.ok(merged(r), `应产出墓碑：${a} <> ${b}`)
  }
})

test('用户实测的那一对改写：默认参数下 merges>=1（修复前为 0）', () => {
  const r = pair('主人下雨天喜欢呆在家里看书', '下雨天主人最喜欢呆在家里面看书')
  assert.ok(r.merges.length >= 1, `应至少合并一次，实际 merges=${r.merges.length}`)
  assert.equal(r.conflicts.length, 0, '这是重复，不该被当成矛盾证伪')
})

// ---------------- ② 红线：绝不能误并 ----------------
const MUST_NOT_MERGE = [
  // 猫/狗、喜欢/不喜欢：memory-dedupe.test.js 的既有红线
  ['小雨养了一只猫叫团子', '小雨养了一只狗叫团子'],
  ['阿强喜欢钓鱼', '阿强不喜欢钓鱼'],
  ['主人喜欢吃辣', '主人不喜欢吃辣'],
  ['主人养了一只猫', '主人养了一只狗'],
  // 单值槽位被改写
  ['主人的生日是3月5日', '主人的生日是3月6日'],
  ['主人昨天买了新手机', '主人今天买了新手机'],
  ['主人喜欢在早上跑步', '主人喜欢在晚上跑步'],
  ['主人喜欢吃辣椒炒肉', '主人不喜欢吃辣椒炒肉'],
  ['阿强在北京工作', '阿强在上海工作'],
  ['主人住在北京', '主人住在上海'],
  ['主人最喜欢喝咖啡', '主人最喜欢喝茶'],
  // 语序颠倒 = 主宾换位，语义完全不同（字符袋一模一样，只能靠语序闸门挡）
  ['小明喜欢小红', '小红喜欢小明'],
  ['张三打了李四', '李四打了张三'],
  ['妈妈给爸爸打电话', '爸爸给妈妈打电话'],
  ['阿强给了小明一本书', '小明给了阿强一本书'],
]

test('红线：降阈值后猫/狗、喜欢/不喜欢、日期、主宾换位绝不被当成重复合并', () => {
  // 关键区分（本缺陷最容易修坏的地方）：
  //   · duplicate 合并 = 「这俩是同一件事」，代表条目吸收另一条 —— 绝不能发生在下面这些样本上；
  //   · conflict 证伪 = 「这是同一槽位被改写了」，旧条立墓碑、新条存活 —— 这才是正确行为。
  // 所以红线断言的是 merges 为空，而不是「两条都必须活着」：
  // 单值槽位（猫→狗、3月5日→3月6日）本来就该走证伪，只留改写后的那条。
  for (const [a, b] of MUST_NOT_MERGE) {
    const r = pair(a, b)
    assert.equal(r.ok, true, `${a} <> ${b}`)
    assert.equal(r.merges.length, 0, `绝不能当成重复合并：${a} <> ${b}（实际 ${JSON.stringify(r.merges)}）`)
    // 若只剩一条，必须是「证伪」的结果（旧条在墓碑里），而不是「合并」吞掉的
    if (r.facts.length === 1) {
      assert.ok(r.conflicts.length === 1, `只剩一条时应是矛盾证伪：${a} <> ${b}`)
      assert.ok(r.supersede.length >= 1, `被证伪的旧条必须立墓碑（只增不改）：${a} <> ${b}`)
    } else {
      assert.deepEqual(r.facts.map((f) => f.text).sort(), [a, b].sort(), `两条都应原样保留：${a} <> ${b}`)
    }
  }
})

test('红线：pinned 不会让「猫/狗」被当成重复合并（该走矛盾证伪）', () => {
  // 猫/狗 语义相反：应当被判为矛盾（旧条立墓碑、新条胜出），而不是被去重合并。
  // pinned 只影响"合并后谁当代表"，绝不能把两条不同事实并成一条 duplicate 墓碑。
  const r = consolidate([
    { id: 'A', text: '小雨养了一只猫叫团子', scope: 'private:10001', importance: 0.4, at: 1, pinned: true, topic: 't' },
    { id: 'B', text: '小雨养了一只狗叫团子', scope: 'private:10001', importance: 0.9, at: 2, topic: 't' },
  ], opts())
  assert.equal(r.merges.length, 0, '猫/狗 绝不能算重复（duplicate）')
  // 走的是单值槽位改写（矛盾证伪），不是合并：只留一条，且旧条在墓碑里。
  assert.equal(r.facts.length, 1, '按单值槽位改写走矛盾证伪：只剩一条')
  // pinned 优先于 importance（better() 的既有规则），所以留下的是 pinned 的猫那条。
  assert.equal(r.facts[0].pinned, true, '胜出条目保留 pinned')
  assert.equal(r.facts[0].text, '小雨养了一只猫叫团子', 'pinned 条目优先留存')
  assert.ok(r.supersede.some((s) => s.oldId !== s.newId), '被改写的那条立墓碑（不是删除）')
})

test('红线：pinned 的重复条目仍会被合并，且代表保留 pinned', () => {
  // 真正的重复（同一句话）即使 pinned 也该合并，且合并后代表必须是 pinned 的那条
  const r = consolidate([
    { id: 'A', text: '主人喜欢在雨天喝热咖啡', scope: 'private:10001', importance: 0.1, at: 1, pinned: true, topic: 't' },
    { id: 'B', text: '主人喜欢在雨天喝热咖啡', scope: 'private:10001', importance: 0.9, at: 2, topic: 't' },
  ], opts())
  assert.equal(r.facts.length, 1)
  assert.equal(r.facts[0].pinned, true, '合并后代表应保留 pinned')
})

test('红线：真正重复（极性一致）不算矛盾，仍走合并', () => {
  const r = pair('阿强喜欢钓鱼', '阿强喜欢钓鱼呀')
  assert.equal(r.conflicts.length, 0, '同极性不是矛盾')
  assert.equal(r.facts.length, 1, '同极性的重复应合并')
})

// ---------------- 阈值取值本身的约束 ----------------
test('阈值取在有实测依据的区间，且保留更严的第一级', () => {
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeSimilarity >= 0.5, '内容阈值不得低于 0.5（否则粗筛形同虚设）')
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeSimilarity <= 0.7, '内容阈值不应高于 0.7（否则真实改写又被漏掉）')
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeSimilarity < 0.82, '必须低于旧的 0.82 —— 否则缺陷 B 未修复')
  // 第一级沿用旧的 0.82：几乎逐字相同的仍然直接并，行为不变
  assert.equal(DEFAULT_DREAM_OPTIONS.strictDedupeSimilarity, 0.82)
  assert.ok(DEFAULT_DREAM_OPTIONS.strictDedupeSimilarity > DEFAULT_DREAM_OPTIONS.dedupeSimilarity, '第一级必须比第二级严')
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeBag > 0.8, '字符袋闸门要够严才能挡住主宾换位')
  assert.ok(DEFAULT_DREAM_OPTIONS.dedupeOrder > 0.6, '语序闸门要够严才能挡住主宾换位')
})

test('显式传 dedupeSimilarity 仍然生效（旧调用方兼容）', () => {
  // 旧测试用 0.5 显式关掉去重闸门：必须仍然「只合并真正重复的」
  const r = pair('主人下雨天喜欢呆在家里看书', '下雨天主人最喜欢呆在家里面看书', { dedupeSimilarity: 0.5 })
  assert.equal(r.facts.length, 1, '显式放宽阈值后仍应合并这对改写')
})
