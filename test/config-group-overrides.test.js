// group.overrides 归一化（#267 明确的行为变更，必须锁死，否则以后没人知道它是故意的）
//
// 背景：#271 拆 config.js 时顺手加了第一版 normalizeGroupOverrides（复用顶层 applyGroupPolicyFields），
// #267 又按面板真实语义重写了一版。最终口径是 #267 的，**与 main 之前「加载期完全不校验」不同**：
//
//   改之前：`if (!isObj(g.overrides)) g.overrides = {}` —— 每个群的覆盖值原样透传，不夹值不校验。
//   改之后：加载配置时就按字段夹到合法区间、把面板清空写下的 '' / null / 布尔当成「没填」、
//           丢掉一个合法字段都没有的条目。
//
// 为什么必须这样（不是洁癖）：
//   · 面板的数字框（NumInput）清空后写的是 ''，语义是「恢复默认」。若不认这个哨兵，
//     `Number('') || 0` 会变成 0 —— 「每个群每小时上限」这类设置会被静默改成 0 而彻底哑掉。
//   · 群覆盖的合法上界比顶层宽松（如 maxPerHour 顶层 0..200，覆盖允许到 10000）：
//     某个群确实可能要比全局更宽的预算，不该被顶层的夹值范围按死。

import test from 'node:test'
import assert from 'node:assert/strict'

const { normalize } = await import('../src/core/config.js')

/** 只关心 group.overrides，其余字段走默认。 */
const withOverrides = (overrides, group = {}) => normalize({ group: { ...group, overrides } }).group.overrides

test('面板清空写的哨兵值一律当「没填」：不进结果，不会把设置静默归零', () => {
  const out = withOverrides({
    '777': {
      interjectChance: '',        // NumInput 清空
      cooldownSec: null,
      maxPerHour: undefined,
      engagedMaxReplies: true,    // 布尔不是数字
      engagedMaxMs: '   ',        // 全空白字符串
    },
  })
  // 一个合法数字都没填 → 整条被丢掉，读侧照常落到顶层默认
  assert.equal(out['777'], undefined, '全是哨兵值时整条丢弃，不是留一堆 0')
})

test('哨兵值不会污染同一条里其它已填字段', () => {
  const out = withOverrides({
    '777': { interjectChance: '', minRelevance: 0.25 },
  })
  assert.equal(out['777'].interjectChance, undefined, '清空的那项不该写成 0')
  assert.equal(out['777'].minRelevance, 0.25, '同一里已填的项照常生效')
})

test('越界值加载时就夹到合法区间（不是原样透传给下游）', () => {
  const out = withOverrides({
    '777': {
      interjectChance: 5,        // 上界 1
      minRelevance: -3,          // 下界 0
      activeWindowSec: 10,       // 下界 30
      quietHours: [99, -1],      // 0..23
    },
  })
  assert.equal(out['777'].interjectChance, 1)
  assert.equal(out['777'].minRelevance, 0)
  assert.equal(out['777'].activeWindowSec, 30)
  assert.deepEqual(out['777'].quietHours, [23, 0], '安静时段逐项夹到 0..23')
})

test('群覆盖的预算上界比顶层宽松：maxPerHour 允许到 10000（顶层只到 200）', () => {
  const out = withOverrides({ '777': { maxPerHour: 5000, engagedMaxReplies: 2000 } })
  assert.equal(out['777'].maxPerHour, 5000, '单个群允许比全局更宽的预算')
  assert.equal(out['777'].engagedMaxReplies, 2000)
})

test('wakeWords / interests 接受字符串与数组两种写法，空白项被过滤', () => {
  const out = withOverrides({
    '777': { wakeWords: '小鱼，鱼宝 小鱼', interests: ['番剧', '', '  ', '游戏'] },
    '888': { wakeWords: ['甲', '乙'], interests: '番剧 游戏' },
  })
  assert.deepEqual(out['777'].wakeWords, ['小鱼', '鱼宝', '小鱼'], '中英文逗号与空格都能分，重复不去重（保持用户原样）')
  assert.deepEqual(out['777'].interests, ['番剧', '游戏'])
  assert.deepEqual(out['888'].wakeWords, ['甲', '乙'])
  assert.deepEqual(out['888'].interests, ['番剧', '游戏'])
})

test('空数组是「显式清空」，要保留；而不是当没填丢掉', () => {
  const out = withOverrides({ '777': { wakeWords: [], interests: [] } })
  assert.deepEqual(out['777'].wakeWords, [])
  assert.deepEqual(out['777'].interests, [])
})

test('群号键归一化：非法键与非法值整条丢弃，合法键去掉非数字字符', () => {
  const out = withOverrides({
    '': { interjectChance: 0.5 },              // 空键丢
    'group:777': { interjectChance: 0.5 },     // 归一成 777
    '999': 'not-an-object',                     // 值不是对象丢
    '888': { totallyUnknownKey: 1 },           // 没有可识别字段丢
  })
  assert.equal(out[''], undefined)
  assert.equal(out['999'], undefined)
  assert.equal(out['888'], undefined, '一个可识别字段都没有的条目整条丢弃')
  assert.equal(out['777'].interjectChance, 0.5)
})

test('overrides 不是对象时兜底成空对象，不抛', () => {
  assert.deepEqual(withOverrides(null), {})
  assert.deepEqual(withOverrides('nope'), {})
  assert.deepEqual(withOverrides([]), {})
})

test('顶层群值参与兜底：覆盖里填了非法字符串时落到顶层的同类值', () => {
  const out = withOverrides({ '777': { interjectChance: 'abc' } }, { interjectChance: 0.4 })
  // 'abc' 不是有限数 → num 走 fallback（顶层的 0.4），而不是归零
  assert.equal(out['777'].interjectChance, 0.4, '非法字符串落到顶层值，不该变成 0')
})