// US-019 · S2 慢思考判定层
//
// 守的三件事：
//   ① 正常返回时挑得出线索，且形状是 [{type, summary}]；
//   ② **fail-open**：模型报错 / 超时 / 非法 JSON / 没模型，一律返回 []，绝不抛；
//   ③ **去幻觉**：summary 在原文里找不到锚点的，一律丢弃。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  judgeThreads, parseJudgeOutput, sanitizeJudgedThreads, hasTextAnchor,
  THREAD_JUDGE_SYSTEM, MAX_JUDGED_THREADS, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS,
} from '../src/chat/thread-judge.js'
import { THREAD_TYPES } from '../src/chat/thread-ledger.js'

const KEY = 'private:1000'
const CORPUS = '甲：我先去洗个澡，等我一下\n乙：好，去吧\n甲：对了明天把那个链接发你'

const CFG = { model: { provider: 'p', model: 'm' } }

/** 假 dsh：askModel 走假 llm.stream，返回值由 reply 决定（函数/字符串/抛错都可）。 */
function fakeDsh(reply) {
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo() { throw new Error('adapter 不支持查询') }, // 非推理模型：不传 reasoningEffort
      async *stream(params) {
        calls.push(params)
        const out = typeof reply === 'function' ? await reply(params) : reply
        if (out instanceof Error) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: out.message } } }
          return
        }
        yield { type: 'text-delta', text: String(out) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { dsh, calls }
}

test('模型正常返回 → 挑出线索，类型在白名单里', async () => {
  const { dsh, calls } = fakeDsh('[{"type":"temporary_leave","summary":"他去洗澡了"},{"type":"promise","summary":"明天把链接发我"}]')
  const rows = await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: CORPUS })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.type), ['temporary_leave', 'promise'])
  for (const row of rows) {
    assert.ok(THREAD_TYPES.includes(row.type))
    assert.equal(typeof row.summary, 'string')
  }
  assert.equal(calls.length, 1, '只调一次模型')
  assert.equal(calls[0].maxTokens, DEFAULT_MAX_TOKENS, '有 maxTokens 上限')
  assert.ok(calls[0].system.includes('【顺承前情】') === false, '判定提示词不该混入 <inner> 契约')
  assert.match(calls[0].system, /只输出 JSON 数组/, '严格 JSON 输出协议')
  assert.match(calls[0].system, /示例/, '带 few-shot 示例')
})

test('模型报错 → fail-open 返回 []，不抛', async () => {
  const { dsh } = fakeDsh(new Error('网关 502'))
  const rows = await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: CORPUS })
  assert.deepEqual(rows, [])
})

test('超时 → fail-open 返回 []（有超时上限，不会挂住投递链路）', async () => {
  // 假模型永不按时返回；定时器 unref，免得测试进程陪着它耗到超时
  const { dsh } = fakeDsh(() => new Promise((resolve) => { const t = setTimeout(() => resolve('[]'), 5000); t.unref?.() }))
  const started = Date.now()
  const rows = await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: CORPUS, timeoutMs: 100 })
  assert.deepEqual(rows, [])
  assert.ok(Date.now() - started < 3000, '必须真的按超时收手')
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 60_000, '默认超时是有界的')
})

test('没模型 / dsh 是空壳 → fail-open 返回 []', async () => {
  assert.deepEqual(await judgeThreads({ dsh: null, cfg: CFG, chatKey: KEY, recentText: CORPUS }), [])
  assert.deepEqual(await judgeThreads({ dsh: { get: () => null }, cfg: CFG, chatKey: KEY, recentText: CORPUS }), [])
})

test('非法 JSON → 丢弃（返回 []）', async () => {
  for (const bad of ['我挑不出来', '{"type":"promise"}', '[{"type":"promise",}', '[]extra']) {
    const { dsh } = fakeDsh(bad)
    const rows = await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: CORPUS })
    if (bad === '[]extra') {
      // 前面是合法空数组：解析成功、结果为空，同样返回 []
      assert.deepEqual(rows, [], bad)
      continue
    }
    assert.deepEqual(rows, [], `非法输出应当丢弃：${bad}`)
  }
})

test('幻觉 summary 被丢弃（原文里找不到锚点）', async () => {
  const { dsh } = fakeDsh('[{"type":"promise","summary":"他答应周末陪我看电影"}]')
  const rows = await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: CORPUS })
  assert.deepEqual(rows, [], '原文没有「电影」，就该丢掉')
})

test('真线索留、幻觉丢：同一批里混着也能只留真的', () => {
  const entries = [
    { type: 'temporary_leave', summary: '他去洗澡了' },
    { type: 'promise', summary: '他答应周末陪我看电影' },
  ]
  const rows = sanitizeJudgedThreads(entries, CORPUS)
  assert.deepEqual(rows.map((r) => r.type), ['temporary_leave'])
})

test('非法类型 / 空摘要 / 重复条目都被过滤', () => {
  const entries = [
    { type: 'omg_type', summary: '他去洗澡了' },
    { type: 'temporary_leave', summary: '   ' },
    { type: 'temporary_leave', summary: '他去洗澡了' },
    { type: 'temporary_leave', summary: '他去洗澡了。' }, // 归一化后与前一条同一条
    null,
    'x',
  ]
  const rows = sanitizeJudgedThreads(entries, CORPUS)
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].summary, '他去洗澡了')
})

test('条数上限：模型返回一大堆也只收前几条', () => {
  const many = Array.from({ length: 20 }, () => ({ type: 'promise', summary: '明天把链接发你' }))
  const rows = sanitizeJudgedThreads(many, CORPUS)
  assert.ok(rows.length <= MAX_JUDGED_THREADS, String(rows.length))
})

test('parseJudgeOutput 容忍代码围栏与前后废话', () => {
  assert.deepEqual(parseJudgeOutput('```json\n[{"type":"promise"}]\n```'), [{ type: 'promise' }])
  assert.deepEqual(parseJudgeOutput('判定如下：[{"type":"promise"}] 以上'), [{ type: 'promise' }])
  assert.deepEqual(parseJudgeOutput('[]'), [])
  assert.throws(() => parseJudgeOutput(''), /未返回内容/)
  assert.throws(() => parseJudgeOutput('没有数组'), /不是合法 JSON/)
})

test('锚点判定：改写能过，编造不能过', () => {
  assert.equal(hasTextAnchor('他去洗澡了', CORPUS), true)
  assert.equal(hasTextAnchor('他去洗澡', '我先去洗个澡'), true, '改写不该被误杀')
  assert.equal(hasTextAnchor('他答应周末陪我看电影', CORPUS), false)
  assert.equal(hasTextAnchor('', CORPUS), false)
  assert.equal(hasTextAnchor('随便', ''), false)
})

test('空原文直接返回 []，连模型都不调（省一次调用）', async () => {
  const { dsh, calls } = fakeDsh('[]')
  assert.deepEqual(await judgeThreads({ dsh, cfg: CFG, chatKey: KEY, recentText: '   ' }), [])
  assert.equal(calls.length, 0)
})

test('判定提示词把四类都写清了，并明确「拿不准就输出空数组」', () => {
  for (const type of THREAD_TYPES) assert.ok(THREAD_JUDGE_SYSTEM.includes(type), `提示词没声明 ${type}`)
  assert.match(THREAD_JUDGE_SYSTEM, /拿不准就不要输出/)
  assert.match(THREAD_JUDGE_SYSTEM, /必须\*\*还没了结\*\*/)
})