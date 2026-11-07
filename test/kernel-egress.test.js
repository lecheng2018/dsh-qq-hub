// 出口后处理链中间件单元测试（RFC-0001 §2 Egress Chain / §4 Phase 1，US-006）。
//
// 全程假 now 零真睡。四组：①对抗语料 14 条（成对/大写/属性/嵌套/悬挂/错名/多悬挂/
// think 内超长/颜文字 <3/词表外 <thinking>/全 think/[沉默]/段落中段）统一断言外发序列
// 零词表 token、捕获率 13/13；②分条 6 例；③冻结与同一性（快照前后 JSON 一致、新段对象
// !== 原段对象）；④reportStage('egress') 假时钟恰好一次。
// 注：<thinking> 不在 stripReasoning 词表内，本测试钉住「透传」这一已定语义——词表是否
// 扩充留给主人拍板（progress Learnings 已记），拍板后此条期望值需同步改。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from '../src/kernel/context.js'
import { createEgressMiddleware } from '../src/kernel/mw-egress.js'

// ---- 桩件 ----

function envelope() {
  return {
    id: 'evt-1', protocol: 'onebot:v11', type: 'message', timestamp: 1,
    selfId: 'bot-1', sender: { userId: 'u-1' },
    segments: [{ type: 'text', data: { text: 'hi' } }], rawText: 'hi',
    rawPayload: { post_type: 'message' },
  }
}

const textSegs = (text) => [{ type: 'text', data: { text } }]

/** 走完整中间件：next 桩里入队给定 payloads，返回处理后的队列数组。 */
async function runEgress(payloads, options = {}) {
  const ctx = createContext(envelope(), 'onebot')
  const mw = createEgressMiddleware(options)
  let nextCalled = 0
  await mw(ctx, async () => {
    nextCalled += 1
    for (const p of payloads) ctx.reply.enqueue(p)
  })
  assert.equal(nextCalled, 1, '必须先 await next() 再接管队列')
  return { ctx, queue: [...ctx.reply.queue] }
}

const flatText = (queue) =>
  queue.flatMap((it) => it.segments.filter((s) => s.type === 'text').map((s) => s.data.text)).join('|')

const TOKEN_RE = /<\/?(think|thought|reasoning|reflection|antThinking)/i

// ---- ① 对抗语料表（14 条，≥12 达标；词表外 <thinking 一条不计捕获分母） ----

const LEAK_CORPUS = [
  { name: '成对闭合', in: '你好<think>秘密</think>世界', out: '你好世界' },
  { name: '大写标签', in: 'A<THINK>秘密</THINK>B', out: 'AB' },
  { name: '属性标签', in: 'A<think type="reasoning">秘密</think>B', out: 'AB' },
  { name: '双重嵌套全闭合', in: 'A1<think>B1<thought>C1</thought>D1</think>E1', out: 'A1E1' },
  { name: '只开不闭(守卫截尾)', in: '正文K<think>秘密K', out: '正文K' },
  { name: '只闭不开(剥token保文)', in: '正文</think>尾巴', out: '正文尾巴' },
  { name: '错名配对(截尾)', in: '正文J<think>秘密J</thought>尾巴J', out: '正文J' },
  { name: '多悬挂开(最早截)', in: 'A2<think>B2<thought>C2D2', out: 'A2' },
  { name: 'think内4001字(清洗先行)', in: '真实答案<think>' + '漏'.repeat(4001) + '</think>', out: '真实答案', maxOut: 1 },
  { name: '正文含<3颜文字(不误伤)', in: '爱你<3 么么哒', out: '爱你<3 么么哒' },
  // 词表外（不计捕获分母）：<thinking> 透传是已定语义，扩充与否留给主人拍板。
  { name: '<thinking>词表外(透传)', in: '甲<thinking>note</thinking>乙', out: '甲<thinking>note</thinking>乙', vocab: false },
  { name: '全think输出(队列空)', in: '<think>全部秘密</think>', out: '', maxOut: 0 },
  { name: '[沉默](整项丢弃)', in: '  [沉默]  ', out: '', maxOut: 0 },
  { name: 'think包裹段落中段(零残留)', in: '前段文字<think>内心独白与 reasoning 记录</think>后段文字', out: '前段文字后段文字' },
]

test('对抗语料 14 条：外发零词表 token，捕获率 13/13', async () => {
  let captured = 0
  let vocabRows = 0
  for (const row of LEAK_CORPUS) {
    const { queue } = await runEgress([{ targetType: 'private', targetId: 'u-1', priority: 'NORMAL', segments: textSegs(row.in) }])
    const out = flatText(queue).split('|').join('')
    assert.equal(out, row.out, row.name)
    if (row.maxOut !== undefined) assert.equal(queue.length, row.maxOut, `${row.name} 队列长度`)
    if (row.vocab === false) {
      assert.ok(out.includes('<thinking>'), '<thinking> 应原样透传')
      continue
    }
    vocabRows += 1
    if (!TOKEN_RE.test(out) && !out.includes('秘密') && !out.includes('独白') && !out.includes('漏'.repeat(5))) captured += 1
  }
  assert.equal(vocabRows, 13)
  assert.equal(captured, 13, '词表内对抗条目应 13/13 零泄漏')
})

// ---- ② 分条 6 例 ----

const priv = (segments, over = {}) => ({ targetType: 'private', targetId: 'u-1', priority: 'NORMAL', segments, ...over })
const segTexts = (queue) => queue.map((it) => it.segments.filter((s) => s.type === 'text').map((s) => s.data.text))

test('恰好 4000 不切', async () => {
  const { queue } = await runEgress([priv(textSegs('a'.repeat(4000)))])
  assert.equal(queue.length, 1)
  assert.equal(queue[0].segments[0].data.text.length, 4000)
})

test('4001 → [4000, 1] 硬切', async () => {
  const { queue } = await runEgress([priv(textSegs('b'.repeat(4001)))])
  assert.deepEqual(segTexts(queue).map((t) => t.map((x) => x.length)), [[4000], [1]])
})

test('句子边界优先于硬切', async () => {
  const long = 'c'.repeat(2000) + '。' + 'c'.repeat(2000) + '！' + '尾'.repeat(100)
  const { queue } = await runEgress([priv(textSegs(long))])
  const pieces = segTexts(queue).flat()
  assert.deepEqual(pieces.map((p) => p.length), [2001, 2101])
  assert.ok(pieces[0].endsWith('。'))
  assert.equal(pieces.join(''), long, '拼回必须无损')
})

test('无边界硬切 8501 → [4000, 4000, 501]', async () => {
  const { queue } = await runEgress([priv(textSegs('d'.repeat(8501)))])
  assert.deepEqual(segTexts(queue).flat().map((p) => p.length), [4000, 4000, 501])
})

test('混合段：首片原位、尾片另起新项、非 text 原样透传', async () => {
  const { queue } = await runEgress([priv([{ type: 'text', data: { text: 'e'.repeat(9000) } }, { type: 'image', data: { file: 'x.png' } }])])
  assert.equal(queue.length, 3)
  assert.deepEqual(segTexts(queue).flat().map((p) => p.length), [4000, 4000, 1000])
  const last = queue[2].segments
  assert.deepEqual(last.map((s) => s.type), ['text', 'image'])
  assert.deepEqual(last[1].data, { file: 'x.png' })
})

test('两项连续处理：顺序与字段携带 deepEqual，id 由 enqueue 重新生成', async () => {
  const p1 = { targetType: 'private', targetId: 'u-1', quoteMessageId: 'q-1', priority: 'HIGH', delayMs: 1200, segments: textSegs('第一<think>泄</think>') }
  const p2 = { targetType: 'group', targetId: 'g-2', priority: 'LOW', segments: textSegs('第二') }
  const { queue } = await runEgress([p1, p2])
  assert.equal(queue.length, 2)
  const carry = (it) => ({ targetType: it.targetType, targetId: it.targetId, quoteMessageId: it.quoteMessageId, priority: it.priority, delayMs: it.delayMs })
  assert.deepEqual(carry(queue[0]), carry(p1))
  assert.deepEqual(carry(queue[1]), carry(p2))
  assert.equal(queue[0].segments[0].data.text, '第一')
  assert.equal(queue[1].segments[0].data.text, '第二')
  assert.ok(queue[0].id !== p1.id && queue[1].id !== p2.id)
})

// ---- ③ 冻结与同一性 ----

test('原快照对象处理前后未被改动（JSON 对比）；新段对象与原段对象无同一性', async () => {
  const ctx = createContext(envelope(), 'onebot')
  ctx.reply.enqueue(priv(textSegs('正文K<think>秘密K')))
  ctx.reply.enqueue(priv([{ type: 'image', data: { file: 'y.png' } }]))
  const snap = [...ctx.reply.queue]
  const before = snap.map((it) => JSON.stringify(it))

  await createEgressMiddleware()(ctx, async () => {})

  assert.deepEqual(snap.map((it) => JSON.stringify(it)), before, '快照原件必须逐字节未被改动')
  const queue = [...ctx.reply.queue]
  assert.equal(queue.length, 2)
  assert.equal(queue[0].segments[0].data.text, '正文K')
  assert.deepEqual(JSON.parse(JSON.stringify(queue[1].segments)), [{ type: 'image', data: { file: 'y.png' } }])
  const origSegs = snap.flatMap((it) => it.segments)
  for (const seg of queue.flatMap((it) => it.segments)) {
    for (const orig of origSegs) {
      assert.ok(seg !== orig, '新段对象不得复用原段对象')
      assert.ok(seg.data !== orig.data, '新 data 对象不得复用原 data')
    }
  }
  for (const it of queue) {
    assert.ok(Object.isFrozen(it) && Object.isFrozen(it.segments))
    assert.ok(!snap.includes(it), '新项不得与快照项同对象')
  }
})

// ---- ④ reportStage 假时钟 ----

test("reportStage('egress') 恰好一次，ms 来自注入假时钟；空队列也打点", async () => {
  const t = [1000, 1734.5]
  const calls = []
  await runEgress([priv(textSegs('甲乙<think>秘密</think>'))], {
    now: () => (t.length > 0 ? t.shift() : 9999),
    reportStage: (name, ms) => calls.push([name, ms]),
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['egress', 734.5])

  const calls2 = []
  await runEgress([], { now: () => 5, reportStage: (n, ms) => calls2.push([n, ms]) })
  assert.deepEqual(calls2, [['egress', 0]])

  // reportStage 抛错不吃崩
  await runEgress([priv(textSegs('安全'))], { reportStage: () => { throw new Error('boom') } })
})
