// Cross-encoder 精排（上游 v1.3.0-beta BGE reranker 语义移植）：
// 只重排 RRF 已召回候选、不扩可见性；失败/超时/未启用退回 RRF 顺序（fail-open）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRerankConfig, applyRerankOrder, createReranker } from '../src/features/memory-rerank.js'

const hit = (id, text = 't' + id) => ({ it: { id, text }, score: 1, why: [] })

test('normalizeRerankConfig：默认关 / 缺 key / 非法 url 都返回 null', () => {
  assert.equal(normalizeRerankConfig({}), null)
  assert.equal(normalizeRerankConfig({ rerankEnabled: true }), null)
  assert.equal(normalizeRerankConfig({ rerankEnabled: true, rerankApiKey: 'k', rerankUrl: 'ftp://x' }), null)
  assert.equal(normalizeRerankConfig(null), null)
  const c = normalizeRerankConfig({ rerankEnabled: true, rerankApiKey: 'k' })
  assert.equal(c.url, 'https://api.siliconflow.cn/v1/rerank')
  assert.equal(c.model, 'BAAI/bge-reranker-v2-m3')
  assert.equal(c.topN, 20)
  assert.equal(normalizeRerankConfig({ rerankEnabled: true, rerankApiKey: 'k', rerankTopN: 999 }).topN, 50)
})

test('applyRerankOrder：按 score 重排前 topN，非法 index 丢弃，未覆盖保持原序', () => {
  const hits = [hit('a'), hit('b'), hit('c'), hit('d')]
  const out = applyRerankOrder(hits, [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }], 3)
  assert.deepEqual(out.map((h) => h.it.id), ['c', 'a', 'b', 'd'], 'topN 之后原样不动')
  // 越界/重复/非整数 index 丢弃
  const out2 = applyRerankOrder(hits, [{ index: 9, relevance_score: 1 }, { index: 1, relevance_score: 0.8 }, { index: 1, relevance_score: 0.9 }, { index: 0.5, relevance_score: 1 }], 3)
  assert.deepEqual(out2.map((h) => h.it.id), ['b', 'a', 'c', 'd'])
  assert.deepEqual(applyRerankOrder(hits, [], 3).map((h) => h.it.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(applyRerankOrder(hits, null, 3).map((h) => h.it.id), ['a', 'b', 'c', 'd'])
  // 不增不减：输出与输入同一集合
  assert.equal(out.length, hits.length)
})

test('createReranker：未启用短路，不调 fetch', async () => {
  let called = 0
  const r = createReranker({ getConfig: () => ({}), fetchImpl: async () => { called += 1; throw new Error('不应调用') } })
  assert.equal(r.enabled(), false)
  const hits = [hit('a'), hit('b')]
  assert.equal(await r.rerank('q', hits), hits)
  assert.equal(called, 0)
})

test('createReranker：成功重排，请求体与鉴权头正确', async () => {
  let req = null
  const r = createReranker({
    getConfig: () => ({ ext: { memory: { rerankEnabled: true, rerankApiKey: 'secret-k', rerankUrl: 'https://mock/rerank', rerankModel: 'rm', rerankTopN: 2 } } }),
    fetchImpl: async (url, opts) => { req = { url, opts }; return { ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }) } },
  })
  assert.equal(r.enabled(), true)
  const out = await r.rerank('查询', [hit('a'), hit('b'), hit('c')])
  assert.deepEqual(out.map((h) => h.it.id), ['b', 'a', 'c'])
  assert.equal(req.url, 'https://mock/rerank')
  assert.equal(req.opts.headers.Authorization, 'Bearer secret-k')
  const body = JSON.parse(req.opts.body)
  assert.equal(body.model, 'rm')
  assert.equal(body.query, '查询')
  assert.deepEqual(body.documents, ['ta', 'tb'], '只送前 topN 条')
  assert.equal(body.top_n, 2)
  assert.equal(r.status().lastError, '')
})

test('createReranker：HTTP 失败/网络异常退回原序，日志不带 key', async () => {
  const warns = []
  const log = { warn: (m) => warns.push(String(m)) }
  const cfg = () => ({ ext: { memory: { rerankEnabled: true, rerankApiKey: 'secret-k', rerankUrl: 'https://mock/rerank' } } })
  const hits = [hit('a'), hit('b')]
  const r1 = createReranker({ getConfig: cfg, log, fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.deepEqual(await r1.rerank('q', hits), hits)
  assert.match(r1.status().lastError, /503/)
  const r2 = createReranker({ getConfig: cfg, log, fetchImpl: async () => { throw new Error('connection reset') } })
  assert.deepEqual(await r2.rerank('q', hits), hits)
  assert.equal(warns.length, 2)
  assert.equal(warns.some((w) => w.includes('secret-k')), false, '密钥绝不进日志')
})

test('createReranker：超时 abort 退回原序', async () => {
  const r = createReranker({
    getConfig: () => ({ ext: { memory: { rerankEnabled: true, rerankApiKey: 'k', rerankUrl: 'https://mock/rerank' } } }),
    log: { warn() {} },
    fetchImpl: (url, opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))) }),
  })
  const hits = [hit('a'), hit('b')]
  assert.deepEqual(await r.rerank('q', hits, { timeoutMs: 30 }), hits)
  assert.match(r.status().lastError, /aborted/)
})

test('集成：recallHintFused 走精排重排，精排失败退回 RRF', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rerank-int-'))
  const prevDir = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const prevFetch = globalThis.fetch
  const vecOf = (text) => {
    const v = new Array(64).fill(0)
    if (text.includes('甲')) v[0] = 1
    else if (text.includes('乙')) { v[0] = 0.8; v[1] = 0.6 }
    else if (text.includes('丙')) { v[0] = 0.6; v[2] = 0.8 }
    else v[0] = 1 // query
    return v
  }
  let rerankCalls = 0
  let rerankMode = 'ok'
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('/embeddings')) {
      const body = JSON.parse(opts.body)
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return { ok: true, json: async () => ({ data: inputs.map((text) => ({ embedding: vecOf(String(text)) })) }) }
    }
    if (u.includes('/rerank')) {
      rerankCalls += 1
      if (rerankMode === 'fail') return { ok: false, status: 500 }
      const body = JSON.parse(opts.body)
      const n = body.documents.length
      return { ok: true, json: async () => ({ results: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, relevance_score: 1 - i * 0.1 })) }) }
    }
    throw new Error('unexpected url ' + u)
  }
  const { createMemoryStore } = await import('../src/features/memory.js')
  const store = createMemoryStore({
    dsh: { llm: { stream: async function* () { yield { type: 'text-delta', text: 'x' } } } },
    getConfig: () => ({
      ownerQQ: '10001', model: { provider: 'test', model: 'm' },
      memory: { enabled: true, recallCount: 4 },
      ext: { memory: {
        vectorEnabled: true, vectorUrl: 'https://mock/embeddings', vectorApiKey: 'vk', vectorModel: 'em', vectorDim: 64,
        rerankEnabled: true, rerankUrl: 'https://mock/rerank', rerankApiKey: 'rk', rerankModel: 'rm', rerankTopN: 20,
      } },
    }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    globalThis.fetch = prevFetch
    if (prevDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })
  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  // about 用第三人：避免「关于这个人」加权让 BM25 全命中，候选才能来自向量通道
  store.add({ text: '红苹果甲', about: '10003', scope: 'private:10002' })
  store.add({ text: '黄香蕉乙', about: '10003', scope: 'private:10002' })
  store.add({ text: '紫橘子丙', about: '10003', scope: 'private:10002' })
  await store.vectorBackfill(store.list(''))
  // 查询与三条记忆无字词重叠 → BM25 空，候选全来自向量通道（cos 甲>乙>丙）
  const hint = await store.recallHintFused(chat, ' completely unrelated query ')
  assert.equal(rerankCalls >= 1, true, '精排被调用')
  assert.equal(hint.includes('紫橘子丙'), true)
  const posJia = hint.indexOf('红苹果甲')
  const posBing = hint.indexOf('紫橘子丙')
  assert.equal(posBing < posJia, true, '精排倒序生效：丙在甲前')
  // 精排失败 → 退回 RRF 顺序（甲在丙前），召回不中断
  rerankMode = 'fail'
  const hint2 = await store.recallHintFused(chat, ' completely unrelated query ')
  assert.equal(hint2.includes('红苹果甲'), true)
  assert.equal(hint2.indexOf('红苹果甲') < hint2.indexOf('紫橘子丙'), true, 'fail-open 退回 RRF')
})
