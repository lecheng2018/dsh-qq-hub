// 蒸馏流水线（L1→L2→L3）契约测试：纯逻辑层 + memory 接线（增量触发/限流/派生卡增长段）

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  shouldTriggerL1, shouldTriggerL2, behaviorStats, renderBehaviorDigest,
  buildL1Prompt, parseL1, buildL2Prompt, parseL2, buildL3Prompt, parseL3, renderGrowthSegment,
} from '../src/features/distill-pipeline.js'
import { createMemoryStore } from '../src/features/memory.js'
import { buildDerivedBody } from '../src/persona/distill-card.js'

const L1_JSON = '{"user_id":"555","batch_id":"b-1","language_features":["口头禅「斩」","短句连发"],"behavior_features":["深夜活跃"],"topic_features":["聊游戏"]}'
const L2_JSON = '{"user_id":"555","scene_templates":{"casual_chat":{"length":"很短","tone":"玩梗","participation":"很高","phrases":["接梗"]},"topic_discuss":{"length":"完整","tone":"讲逻辑"},"gossip_interact":{}}}'
const L3_JSON = '{"user_id":"555","persona_segment":{"core_character":"你在群里是个爱接梗的急性子","speech_rules":"多用短句和反问，随口用「斩」催办","behavior_boundary":"聊游戏必插话，工作话题潜水"},"update_note":"稳定特征 +2"}'

// ---------- 触发判定 ----------

test('L1 触发：条数达标 + 距上次 ≥ 间隔；刷屏狂聊被限流', () => {
  assert.equal(shouldTriggerL1({ newCount: 9, lastL1At: 0 }), false, '9 条不够')
  assert.equal(shouldTriggerL1({ newCount: 10, lastL1At: 0 }), true, '10 条且从没跑过')
  assert.equal(shouldTriggerL1({ newCount: 10, lastL1At: Date.now() - 1000 }), false, '1 小时内跑过 → 限流')
  assert.equal(shouldTriggerL1({ newCount: 30, lastL1At: Date.now() - 3600_000 }), true, '满 1 小时后放行')
})

test('L2 触发：累计 5 批且未消费', () => {
  assert.equal(shouldTriggerL2({ batches: [1, 2, 3, 4], batchesSinceL2: 4 }), false)
  assert.equal(shouldTriggerL2({ batches: [1, 2, 3, 4, 5], batchesSinceL2: 5 }), true)
  assert.equal(shouldTriggerL2({ batches: [1, 2, 3, 4, 5, 6], batchesSinceL2: 2 }), false, '刚聚合过不重复')
})

// ---------- 行为统计（纯代码，零 token） ----------

test('behaviorStats：活跃时段/中位间隔/接话率全部来自时间戳精确计算', () => {
  // 时间基准取本地今天 10:00（getHours 是本地时区，固定 UTC 常数会在东八区漂移）
  const H = 3600_000
  const t0 = new Date(new Date().setHours(10, 0, 0, 0)).getTime()
  const lines = [
    { t: t0, uid: '555', text: '早' },
    { t: t0 + 30_000, uid: '666', text: '早啊' },
    { t: t0 + 50_000, uid: '555', text: '吃了吗' },   // 60s 内接话 → interject
    { t: t0 + 300_000, uid: '777', text: '哈哈哈' },
    { t: t0 + 700_000, uid: '555', text: '咋都不说话' }, // 可判定接话但超过 60s → 不算
    { t: t0 + 12 * H, uid: '555', text: '睡不着' },
    { t: t0 + 12 * H + 120_000, uid: '555', text: '还在吗' }, // 本人相邻间隔 120s
  ]
  const s = behaviorStats(lines, '555')
  assert.equal(s.msgs, 5)
  assert.equal(s.activeHours[10], 0.6, '10 点占 3/5')
  assert.equal(s.activeHours[22], 0.4, '22 点占 2/5')
  assert.equal(s.medianIntervalMs, 650_000, '本人相邻间隔排序取中位（50s,650s,11.5H,120s → 650s）')
  assert.equal(s.interjectRate, 0.5, '两次可判定接话，其中 1 次 60s 内接上')
  assert.match(renderBehaviorDigest(s), /活跃时段/)
  assert.equal(renderBehaviorDigest(behaviorStats(lines, 'nobody')), '', '没这个人就空摘要')
})

// ---------- 提示词与解析 ----------

test('L1：提示词带 user_id/batch_id/行为摘要；解析容忍围栏与前后缀；字段封顶', () => {
  const p = buildL1Prompt({ uid: '555', batchId: 'b-1', messages: ['你好', '在吗'], context: [{ name: '别人', text: '干嘛' }], behaviorDigest: '活跃时段：10 点' })
  assert.match(p.system, /蒸馏引擎/)
  assert.match(p.system, /user_id/)
  assert.match(p.text, /目标用户ID：555/)
  assert.match(p.text, /活跃时段：10 点/, '行为摘要进提示词（LLM 只归纳不猜数）')
  const rec = parseL1('```json\n模型解释…' + L1_JSON + '\n```', { uid: '555', batchId: 'b-1' })
  assert.equal(rec.user_id, '555')
  assert.equal(rec.batch_id, 'b-1')
  assert.deepEqual(rec.language_features, ['口头禅「斩」', '短句连发'])
  assert.equal(rec.topic_features[0], '聊游戏')
  assert.equal(parseL1('不是 JSON', {}), null)
  // 封顶：language 最多 8 条
  const big = parseL1(JSON.stringify({ user_id: 'x', batch_id: 'b', language_features: Array.from({ length: 20 }, (_, i) => 'f' + i) }), {})
  assert.equal(big.language_features.length, 8)
})

test('L2/L3：解析三场景与人格增长段；空段拒绝', () => {
  const l2 = parseL2(L2_JSON, { uid: '555' })
  assert.equal(l2.scene_templates.casual_chat.length, '很短')
  assert.equal(l2.scene_templates.topic_discuss.participation, '', '没写的字段归一为空串（不编内容）')
  assert.equal(l2.scene_templates.gossip_interact, null, '证据不足场景为 null')
  const l3 = parseL3(L3_JSON, { uid: '555' })
  assert.match(l3.persona_segment.speech_rules, /斩/)
  assert.equal(l3.update_note, '稳定特征 +2')
  assert.equal(parseL3('{"user_id":"x","persona_segment":{}}', {}), null, '三模块全空 = 没学到东西')
  const p3 = buildL3Prompt({ uid: '555', oldSegment: null, sceneTemplates: l2.scene_templates })
  assert.match(p3.system, /绝不修改基础身份与安全规则/)
  assert.match(p3.system, /第二人称/)
})

test('增长段渲染：带边界声明（不冒充、不碰身份与安全规则）', () => {
  const l3 = parseL3(L3_JSON, { uid: '555' })
  const text = renderGrowthSegment('555', l3)
  assert.match(text, /人格增长段/)
  assert.match(text, /不改变你的身份、记忆与安全规则/)
  assert.match(text, /别自称他/)
  assert.equal(renderGrowthSegment('555', null), '')
})

// memory 接线用例已随架构迁移到 test/distill-module.test.js（独立 optional 模块）；本文件保留纯逻辑用例。

test('L3 沉淀 → 派生卡正文带增长段（底卡正文不变，边界声明随身）', () => {
  const l3 = parseL3(L3_JSON, { uid: '555' })
  const body = buildDerivedBody('你是大肥鱼。安全规则：不碰危险命令。', [{ name: '老哥', profile: { exchanges: ['问：吃了吗\n答：斩'] } }], [{ uid: '555', segment: l3 }])
  assert.match(body, /^你是大肥鱼。安全规则：不碰危险命令。/, '底卡正文原样保留（人设基底锁定）')
  assert.match(body, /当前群聊语感微调/, '借用段在')
  assert.match(body, /人格增长段/, '增长段在')
  assert.match(body, /不改变你的身份、记忆与安全规则/, '边界声明随身')
  assert.match(body, /多用短句和反问/, 'L3 的说话规则进了卡')
})
