// 压缩摘要的结构化层：五类槽位 → 渲染回一段口语。
// 回归的是 2026-11-17 的复盘：纯文本流水账最容易丢「还没了结的事」和「说好的约定」，
// 而这两类恰恰是下一轮开场最该接的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUMMARY_FIELDS,
  buildSummaryPrompt,
  countPending,
  parseStructuredSummary,
  renderStructuredSummary,
  threadLine,
} from '../src/modules/token-guardian/summary-format.js'

const FULL = {
  topics: ['他在挑光猫'],
  background: ['他说自己是电信的（事实）', '顺带开玩笑说要报销（玩笑）'],
  progress: ['光猫型号定成 F7015MV3'],
  pending: ['他欠我三条信息：运营商、兆数、光衰'],
  agreements: ['他要求私聊里的内容默认不外带（他提的）'],
}

test('五类字段齐全时才认结构化结果', () => {
  assert.deepEqual([...SUMMARY_FIELDS], ['topics', 'background', 'progress', 'pending', 'agreements'])
  const parsed = parseStructuredSummary(JSON.stringify(FULL))
  assert.ok(parsed, '标准 JSON 应该解析成功')
  assert.deepEqual(parsed.pending, FULL.pending)
  assert.equal(countPending(parsed), 1)
})

test('容忍代码块外壳 / 前后废话 / 大写字段名 / 非字符串条目', () => {
  const messy = [
    '好的，摘要如下：',
    '```json',
    JSON.stringify({
      Topics: ['聊光猫'],
      BACKGROUND: ['他是电信的'],
      Progress: [],
      pending: ['还欠三条信息', 123, null, { x: 1 }, ''],
      Agreements: ['私聊不外带'],
    }),
    '```',
    '以上。',
  ].join('\n')
  const parsed = parseStructuredSummary(messy)
  assert.ok(parsed)
  assert.deepEqual(parsed.topics, ['聊光猫'], '大写字段名要归位')
  assert.deepEqual(parsed.pending, ['还欠三条信息'], '非字符串条目丢掉')
  assert.deepEqual(parsed.agreements, ['私聊不外带'])
})

test('解析不了就返回 null（调用方退回纯文本，不让压缩失败）', () => {
  assert.equal(parseStructuredSummary(''), null)
  assert.equal(parseStructuredSummary('   '), null)
  assert.equal(parseStructuredSummary('他们聊了光猫和宽带。'), null, '纯文本')
  assert.equal(parseStructuredSummary('{"topics":'), null, '半截 JSON')
  assert.equal(parseStructuredSummary('{"topics":[],"background":[]}'), null, '五类全空不算成功')
  assert.equal(parseStructuredSummary('[{"topics":[]}]'), null, '顶层是数组不算')
  assert.equal(parseStructuredSummary('null'), null)
})

test('渲染成一段连贯口语，不出现列表符号或字段名', () => {
  const text = renderStructuredSummary(FULL)
  assert.ok(text.includes('之前主要在聊他在挑光猫'))
  assert.ok(text.includes('还没了结的有他欠我三条信息'))
  assert.ok(text.includes('你们之前说好他要求私聊里的内容默认不外带'))
  assert.ok(text.endsWith('。'), '收在句号上')
  for (const bad of ['- ', '* ', '##', 'topics', 'pending', 'agreements', '\n']) {
    assert.ok(!text.includes(bad), `不该出现 ${JSON.stringify(bad)}`)
  }
})

test('渲染：空的类直接跳过，全空返回空串', () => {
  assert.equal(renderStructuredSummary({ topics: ['聊光猫'] }), '之前主要在聊聊光猫。')
  assert.equal(renderStructuredSummary({ topics: [], pending: [], progress: [] }), '')
  assert.equal(renderStructuredSummary(null), '')
})

test('渲染：单条超长会被截断，不切断代理对', () => {
  const long = '😀'.repeat(200)
  const text = renderStructuredSummary({ topics: [long] })
  const body = text.replace('之前主要在聊', '').replace(/。$/, '')
  assert.ok(Array.from(body).length <= 80, `实际 ${Array.from(body).length}`)
  assert.ok(!/\uFFFD/.test(body), '不该出现替换字符')
})

test('buildSummaryPrompt：五类、合并口径、字数上限、只输出 JSON', () => {
  const p = buildSummaryPrompt({ name: '豆包', maxChars: 900 })
  assert.ok(p.includes('「豆包」的记忆整理助手'))
  for (const field of SUMMARY_FIELDS) assert.ok(p.includes(field), `prompt 里要提到 ${field}`)
  assert.ok(p.includes('900 字'))
  assert.ok(p.includes('只输出 JSON'))
  assert.ok(p.includes('"topics":[],"background":[],"progress":[],"pending":[],"agreements":[]'))
  assert.ok(p.includes('不算做完'), '要写清「答应/批准不算做完」')
  assert.ok(p.includes('不要从玩笑话里推待办'))
  assert.ok(!p.includes('更早聊天的摘要】，那是上一份检查点'), '没有旧摘要时不该提合并')
})

test('buildSummaryPrompt：有旧摘要时提合并；字数上限有下限兜底', () => {
  const p = buildSummaryPrompt({ name: '豆包', maxChars: 10, hasPrev: true })
  assert.ok(p.includes('上一份检查点'))
  assert.ok(p.includes('合并后的结果'))
  assert.ok(p.includes('200 字'), 'maxChars 太小要夹到 200')
})

test('buildSummaryPrompt：挂起线索作为输入塞进去，让她并入 pending', () => {
  const p = buildSummaryPrompt({
    name: '豆包', maxChars: 800,
    threadLines: ['答应了某事：明天把链接发他', '问出去还没答：光猫什么型号'],
  })
  assert.ok(p.includes('并进 pending'))
  assert.ok(p.includes('答应了某事：明天把链接发他'))
  assert.ok(p.includes('问出去还没答：光猫什么型号'))
})

test('threadLine：类型翻译成中文，摘要为空就丢掉', () => {
  assert.equal(threadLine({ type: 'promise', summary: '明天发链接' }), '答应了某事：明天发链接')
  assert.equal(threadLine({ type: 'temporary_leave', summary: ' 去洗澡  ' }), '暂时离开：去洗澡')
  assert.equal(threadLine({ type: 'unknown_type', summary: '某件事' }), '挂着的事：某件事')
  assert.equal(threadLine({ type: 'promise', summary: '   ' }), '')
  assert.equal(threadLine(null), '')
  assert.equal(threadLine({}), '')
})

test('渲染后的摘要长度不会超过 summaryMaxChars 太多（含五类都有内容时）', () => {
  const fat = {
    topics: Array.from({ length: 6 }, (_, i) => `话题${i}`.repeat(10)),
    background: Array.from({ length: 6 }, (_, i) => `背景${i}`.repeat(10)),
    progress: Array.from({ length: 6 }, (_, i) => `进展${i}`.repeat(10)),
    pending: Array.from({ length: 6 }, (_, i) => `未完${i}`.repeat(10)),
    agreements: Array.from({ length: 6 }, (_, i) => `约定${i}`.repeat(10)),
  }
  const text = renderStructuredSummary(fat)
  // 每类最多 6 条 × 80 字 + 引导语，30 条的上界；这里只确认它有界、不是无限制膨胀
  assert.ok(Array.from(text).length <= 30 * 80 + 60, `实际 ${Array.from(text).length}`)
})
