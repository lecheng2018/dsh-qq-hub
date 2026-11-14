// US-019 · S1 线索生产者（纯函数，零 I/O）
//
// 守的是「账本为什么一直空」这件事的**入口**：规则层认得出四类未闭环线索，
// 同一句别吐出两条，TTL 按类型给，没命中就干净返回 []。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mineThreads, normalizeThreadSummaryText, TYPE_TTL_MS, MAX_PRODUCER_SUMMARY_CHARS,
} from '../src/chat/thread-producer.js'
import { THREAD_TYPES } from '../src/chat/thread-ledger.js'

const KEY = 'private:1000'

/** 取某个类型的产出（省得每个用例都 filter 一遍）。 */
const of = (list, type) => list.filter((t) => t.type === type)

test('temporary_leave：去洗澡 / 吃饭 / 睡觉 / 上班 / 出门 都认', () => {
  for (const text of ['我去洗个澡，等我一下', '我先去吃饭了', '我睡了，明天聊', '得去上班了', '出门一趟，一会儿回来']) {
    const got = of(mineThreads({ chatKey: KEY, userText: text, now: 1 }), 'temporary_leave')
    assert.equal(got.length >= 1, true, `没认出离开线索：${text}`)
    assert.equal(got[0].chatKey, KEY)
    assert.ok(got[0].summary.length > 0, '摘要不能为空')
  }
})

test('promise：答应 / 明天给你 / 回头发你 / 晚点分享 都认', () => {
  for (const text of ['答应了，明天给你', '我明天把链接发你', '回头发你一份', '晚点分享给你', '周末带给你']) {
    const got = of(mineThreads({ chatKey: KEY, userText: text, now: 1 }), 'promise')
    assert.equal(got.length >= 1, true, `没认出约定线索：${text}`)
  }
})

test('question_pending：她问出去、对方还没答的问题', () => {
  for (const text of ['你吃了吗？', '那个到底怎么样啊？', '你几点回来？']) {
    const got = of(mineThreads({ chatKey: KEY, replyText: text, now: 1 }), 'question_pending')
    assert.equal(got.length >= 1, true, `没认出待答问题：${text}`)
    // 摘要是归一化后的（标点被清掉），但疑问词必须留着，否则进提示词读不出「这是个问题」
    assert.match(got[0].summary, /吗|呢|么|几|哪|什么|怎么|多少/u, '待答问题该保留疑问词：' + got[0].summary)
  }
})

test('topic_postponed：说到一半被打断 / 回头再说', () => {
  for (const text of ['说到一半被打断了', '先不说了，回头再说', '这话没说完，等下再说']) {
    const got = of(mineThreads({ chatKey: KEY, userText: text, now: 1 }), 'topic_postponed')
    assert.equal(got.length >= 1, true, `没认出中断线索：${text}`)
  }
})

test('【备忘】里的线索也会被认（模型比规则更容易注意到「这事没完」）', () => {
  const got = mineThreads({ chatKey: KEY, innerMeta: { memo: '他说明天把链接发我' }, now: 1 })
  assert.equal(got.length, 1)
  assert.equal(got[0].type, 'promise')
})

test('同 chatKey + type + 归一化摘要只产出一条', () => {
  const got = mineThreads({ chatKey: KEY, userText: '我去洗个澡！我去洗个澡。', now: 1 })
  assert.equal(of(got, 'temporary_leave').length, 1, JSON.stringify(got))
  // user 与 memo 说同一件事，也只留一条
  const dup = mineThreads({ chatKey: KEY, userText: '我去洗个澡', innerMeta: { memo: '他去洗澡了' }, now: 1 })
  const norm = dup.map((t) => normalizeThreadSummaryText(t.summary))
  assert.equal(new Set(norm.map((n, i) => `${dup[i].type}|${n}`)).size, dup.length, '不应有重复条目')
})

test('无命中返回 []（寒暄、情绪、已经答完的话都不算线索）', () => {
  for (const text of ['在吗', '今天天气不错', '哈哈哈哈哈', '吃了吗', '好的']) {
    assert.deepEqual(mineThreads({ chatKey: KEY, userText: text, now: 1 }), [], text)
  }
  assert.deepEqual(mineThreads({ chatKey: KEY, now: 1 }), [], '什么都不给就是空')
  assert.deepEqual(mineThreads({ chatKey: '', userText: '我去洗澡了' }), [], '没有会话键不产出')
})

test('TTL 按类型给：离开短、约定长', () => {
  assert.equal(TYPE_TTL_MS.temporary_leave, 2 * 3600_000)
  assert.equal(TYPE_TTL_MS.promise, 24 * 3600_000)
  assert.equal(TYPE_TTL_MS.question_pending, 6 * 3600_000)
  assert.equal(TYPE_TTL_MS.topic_postponed, 4 * 3600_000)
  assert.ok(TYPE_TTL_MS.temporary_leave < TYPE_TTL_MS.promise, '离开必须比约定短')
  const leave = mineThreads({ chatKey: KEY, userText: '我去洗个澡', now: 1 })
  const promise = mineThreads({ chatKey: KEY, userText: '明天给你', now: 1 })
  assert.equal(leave[0].ttlMs, TYPE_TTL_MS.temporary_leave)
  assert.equal(promise[0].ttlMs, TYPE_TTL_MS.promise)
})

test('产出类型只在账本的四类白名单里，且形状对得上 push()', () => {
  const got = mineThreads({
    chatKey: KEY, userText: '我去洗个澡，明天把链接发你', replyText: '你吃了吗？', now: 1,
  })
  assert.ok(got.length >= 3, JSON.stringify(got))
  for (const thread of got) {
    assert.ok(THREAD_TYPES.includes(thread.type), thread.type)
    assert.deepEqual(Object.keys(thread).sort(), ['chatKey', 'summary', 'ttlMs', 'type'])
    assert.equal(typeof thread.summary, 'string')
    assert.equal(typeof thread.ttlMs, 'number')
  }
})

test('摘要归一化：去标点空白、截断到 60 字、绝不为空', () => {
  assert.equal(normalizeThreadSummaryText(' 我 去 洗 澡 。 '), '我去洗澡')
  assert.equal(normalizeThreadSummaryText('！！。，'), '', '纯标点归一成空')
  const long = normalizeThreadSummaryText('啊'.repeat(200))
  assert.equal(Array.from(long).length, MAX_PRODUCER_SUMMARY_CHARS)
  // 截断按 code point 切：emoji 不会被切成孤立代理对（\p{S} 会剥掉纯 emoji，所以掺在字里测）
  const emoji = normalizeThreadSummaryText('啊😀'.repeat(100))
  assert.equal(Array.from(emoji).length, MAX_PRODUCER_SUMMARY_CHARS)
  assert.equal(emoji.includes('\uFFFD'), false, '不许留孤立代理对')
  assert.equal(/[\uD800-\uDBFF]$/u.test(emoji), false, '尾巴不能是半个代理对')
  // 长句只留命中词周围，不把整段塞进摘要
  const got = mineThreads({ chatKey: KEY, userText: '今天真的好累啊上班上到现在才下班我先去洗个澡一会儿再聊', now: 1 })
  assert.equal(got.length >= 1, true)
  for (const thread of got) assert.ok(Array.from(thread.summary).length <= MAX_PRODUCER_SUMMARY_CHARS)
})

test('纯函数：同一个输入调两次结果相同，不读时钟', () => {
  const input = { chatKey: KEY, userText: '我去洗个澡，明天发你', now: 12345 }
  const a = mineThreads(input)
  const b = mineThreads({ ...input, now: 999999 })
  assert.deepEqual(a, b, 'now 不参与判定')
})