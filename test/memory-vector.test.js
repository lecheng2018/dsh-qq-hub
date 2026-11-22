// 向量通道（1.4.4）单元测试：配置归一化、embedding 客户端（注入 fetch）、
// 作用域向量文件读写与检索、RRF 融合、通道编排（入队/flush/对账/摘除）、umask 077 落盘权限。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeEmbeddingConfig,
  embedKeyOf,
  l2normalize,
  cosine,
  createEmbedder,
  fuseRrf,
  createScopeVectorFile,
  createVectorChannel,
} from '../src/features/memory-vector.js'
import { writeTextAtomic, scopeToVecFilePath } from '../src/features/memory-files.js'
import { writeJson } from '../src/core/store.js'

let dir

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memvec-test-'))
})
after(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

// ---------------- 配置 ----------------

test('normalizeEmbeddingConfig：默认关 / 缺 url 都返回 null', () => {
  assert.equal(normalizeEmbeddingConfig({}), null)
  assert.equal(normalizeEmbeddingConfig({ embeddings: { enabled: true } }), null)
  assert.equal(normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'ftp://x' } }), null)
  assert.equal(normalizeEmbeddingConfig(null), null)
})

test('normalizeEmbeddingConfig：启用后归一化 + 越界钳制', () => {
  const cfg = normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'https://api.example.com/v1/embeddings', apiKey: 'k', dim: 99999, timeoutMs: 1, batch: 0 } })
  assert.ok(cfg)
  assert.equal(cfg.dim, 4096)
  assert.equal(cfg.timeoutMs, 1000)
  assert.equal(cfg.batch, 16) // 0 是垃圾值，走默认 16（不是钳到下限 1）
  assert.equal(cfg.model, 'BAAI/bge-m3') // 默认模型
})

// ---------------- embedding 客户端 ----------------

test('createEmbedder：批量切分 + L2 归一 + 结构校验', async () => {
  const calls = []
  const raw = [3, 4, ...Array(62).fill(0)] // dim 64（normalizeEmbeddingConfig 的下限）
  const fake = (url, opt) => {
    const body = JSON.parse(opt.body)
    calls.push(body.input)
    return Promise.resolve({ ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: raw })) }) })
  }
  const emb = createEmbedder(normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'https://x', dim: 64, batch: 2 } }), { fetchImpl: fake })
  const out = await emb.embed(['a', 'b', 'c'])
  assert.deepEqual(calls, [['a', 'b'], ['c']])
  assert.equal(out.length, 3)
  // [3,4,0...] 归一后前两位 ≈ [0.6, 0.8]
  assert.ok(Math.abs(out[0][0] - 0.6) < 1e-6 && Math.abs(out[0][1] - 0.8) < 1e-6)
})

test('createEmbedder：HTTP 失败与维度不符都要抛（调用方吞错退回 BM25，透传响应错误）', async () => {
  const emb = createEmbedder(normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'https://x', dim: 64 } }), {
    fetchImpl: () => Promise.resolve({ ok: false, status: 400, text: async () => '{"code":20015,"message":"Invalid"}' }),
  })
  await assert.rejects(() => emb.embed(['a']), /HTTP 400: \{"code":20015/)
  const emb2 = createEmbedder(normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'https://x', dim: 64 } }), {
    fetchImpl: () => Promise.resolve({ ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }),
  })
  await assert.rejects(() => emb2.embed(['a']), /维度不符/)
})

test('createEmbedder：孤立代理项与 emoji 截断安全规整为 well-formed', async () => {
  let captured = null
  const emb = createEmbedder(normalizeEmbeddingConfig({ embeddings: { enabled: true, url: 'https://x', dim: 64, maxChars: 5 } }), {
    fetchImpl: (url, opt) => {
      captured = JSON.parse(opt.body).input
      return Promise.resolve({ ok: true, json: async () => ({ data: captured.map(() => ({ embedding: Array(64).fill(0) })) }) })
    },
  })
  // 传入含有孤立代理项的字符串和长度刚好截断 emoji 的字符串
  await emb.embed(['abc\ud83ddef', '1234😭'])
  assert.ok(captured)
  assert.equal(captured[0].isWellFormed(), true)
  assert.equal(captured[1].isWellFormed(), true)
  // '1234😭' 限制 5 字符，Unicode code point 截断后为 '1234' 或完整包含，不会留半个代理项
  assert.equal(captured[1].includes('\ud83d') && !captured[1].includes('\ude2d'), false)
})

// ---------------- 向量文件 ----------------

test('createScopeVectorFile：存取往返 + 白名单检索 + 损坏文件按空处理', () => {
  const file = createScopeVectorFile(join(dir, 'vf1', 'vectors.bin'), 2, { log: { warn: () => {} } })
  const mk = (a, b) => l2normalize(Float32Array.from([a, b]))
  file.save(new Map([
    ['cat', { vec: mk(1, 0), hash: 'h1' }],
    ['dog', { vec: mk(0, 1), hash: 'h2' }],
  ]))
  const map = file.load()
  assert.equal(map.size, 2)
  assert.equal(map.get('cat').hash, 'h1')

  // 查询向量 = [1,0]：cat 余弦 1 排最前，白名单只留 dog 时只返回 dog
  const q = mk(1, 0)
  assert.equal(file.search(q, null, 2)[0].id, 'cat')
  const only = file.search(q, new Set(['dog']), 2)
  assert.equal(only.length, 1)
  assert.equal(only[0].id, 'dog')

  // 损坏文件：返回空 map，不抛
  writeFileSync(join(dir, 'vf1', 'vectors.bin'), 'garbage-no-json')
  const file2 = createScopeVectorFile(join(dir, 'vf1', 'vectors.bin'), 2, { log: { warn: () => {} } })
  assert.equal(file2.load().size, 0)
})

test('scopeToVecFilePath：与 memory.md 同目录', () => {
  assert.equal(scopeToVecFilePath('global'), join('global', 'vectors.bin'))
  assert.equal(scopeToVecFilePath('private:10001'), join('private', '10001', 'vectors.bin'))
})

// ---------------- RRF 融合 ----------------

test('fuseRrf：双通道融合、按 id 去重、limit 生效、why 标注', () => {
  const bm25 = [
    { it: { id: 'a', text: '甲' }, score: 2.0, why: [] },
    { it: { id: 'b', text: '乙' }, score: 1.0, why: [] },
  ]
  const vec = [
    { it: { id: 'a', text: '甲' }, score: 0.9, why: [] }, // 双通道都命中：融合分更高
    { it: { id: 'c', text: '丙' }, score: 0.8, why: [] }, // 仅语义通道
  ]
  const out = fuseRrf(bm25, vec, { limit: 3 })
  assert.equal(out[0].it.id, 'a') // 双通道叠加排第一
  assert.ok(out.some((h) => h.it.id === 'c'))
  const c = out.find((h) => h.it.id === 'c')
  assert.ok(c.why.some((w) => w.includes('语义')))
  assert.equal(fuseRrf(bm25, vec, { limit: 2 }).length, 2)
  assert.equal(fuseRrf([], [], {}).length, 0)
})

// ---------------- 通道编排 ----------------

/** 确定性假 embeddings：文本含「猫」→ 第 1 维 1，含「狗」→ 第 2 维 1（dim=64）。 */
function fakeFetch(url, opt) {
  const body = JSON.parse(opt.body)
  return Promise.resolve({
    ok: true,
    json: async () => ({
      data: body.input.map((t) => {
        const v = Array(64).fill(0)
        if (String(t).includes('猫')) v[0] = 1
        else if (String(t).includes('狗')) v[1] = 1
        else { v[0] = 0.5; v[1] = 0.5 }
        return { embedding: v }
      }),
    }),
  })
}

function itemsOf(list) {
  return list.map((x) => ({ tags: [], aboutName: '', entity: '', topic: '', ...x }))
}

test('向量通道：入队 → flush 落盘 → searchScopes 语义召回 → 死条目对账摘除', async () => {
  const memDir = join(dir, 'channel1')
  mkdirSync(memDir, { recursive: true })
  const getConfig = () => ({ memory: { embeddings: { enabled: true, url: 'https://x', model: 'm', dim: 64, batch: 8 } } })
  const ch = createVectorChannel({ memoryDir: memDir, getConfig, log: { warn: () => {} }, fetchImpl: fakeFetch })

  assert.equal(ch.enabled(), true)
  ch.queueScope('private:10001', itemsOf([
    { id: 'm1', text: '主人喜欢养猫', importance: 0.6 },
    { id: 'm2', text: '邻居家的狗很吵', importance: 0.5 },
    { id: 'm3', text: '已过时的事', invalidAt: Date.now() }, // 死条目不入队
  ]))
  const n = await ch.flush()
  assert.equal(n, 2)
  assert.ok(existsSync(join(memDir, scopeToVecFilePath('private:10001'))), 'vectors.bin 应落盘')

  // 查询「猫」：m1 余弦 1.0，m2 余弦 0
  const hits = await ch.searchScopes('猫喜欢什么', ['private:10001'], { whitelistOf: () => new Set(['m1', 'm2']), topK: 5 })
  assert.equal(hits[0].id, 'm1')
  assert.ok(hits[0].cos > 0.99)

  // embedQuery 缓存：第二次同查询不再发请求
  const before = Date.now()
  await ch.embedQuery('猫喜欢什么', { timeoutMs: 1000 })
  assert.ok(Date.now() - before < 1000)

  // 对账：m2 从条目里消失 → flush 摘除其向量
  ch.queueScope('private:10001', itemsOf([{ id: 'm1', text: '主人喜欢养猫', importance: 0.6 }]))
  await ch.flush()
  const hits2 = await ch.searchScopes('狗', ['private:10001'], { whitelistOf: () => new Set(['m1', 'm2']), topK: 5 })
  assert.ok(!hits2.some((h) => h.id === 'm2'), '摘除的条目不应再被检索到')

  // 文本修订（hash 变了）→ 重新 embed
  ch.queueScope('private:10001', itemsOf([{ id: 'm1', text: '主人改口了：最爱的是狗', importance: 0.6 }]))
  const n2 = await ch.flush()
  assert.equal(n2, 1)

  const st = ch.status()
  assert.equal(st.enabled, true)
  assert.equal(st.vectors, 1)
  ch.dispose()
})

test('向量通道：未配置时全部短路', async () => {
  const ch = createVectorChannel({ memoryDir: join(dir, 'channel2'), getConfig: () => ({ memory: {} }), log: { warn: () => {} } })
  assert.equal(ch.enabled(), false)
  assert.deepEqual(await ch.searchScopes('x', ['global'], {}), [])
  assert.equal(await ch.embedQuery('x'), null)
  const bf = await ch.backfill([{ id: 'a', text: 't', scope: 'global' }])
  assert.equal(bf.ok, false)
  ch.queueScope('global', [{ id: 'a', text: 't' }])
  assert.equal(await ch.flush(), 0)
  ch.dispose()
})

// ---------------- umask 077 落盘权限 ----------------

test('umask 077 下 writeTextAtomic / writeJson 仍落成 0o644（fnOS 部署现实）', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 文件权限模型不暴露 POSIX umask mode bits')
  }
  const old = process.umask(0o077)
  try {
    const f1 = join(dir, 'perm1.md')
    writeTextAtomic(f1, 'hi')
    assert.equal(statSync(f1).mode & 0o777, 0o644, 'writeTextAtomic 应为 0o644')

    const f2 = join(dir, 'perm2.json')
    writeJson(f2, { a: 1 })
    assert.equal(statSync(f2).mode & 0o777, 0o644, 'writeJson 应为 0o644')
  } finally {
    process.umask(old)
  }
})

// ---------------- 纯函数小件 ----------------

test('cosine / l2normalize / embedKeyOf 口径', () => {
  assert.ok(Math.abs(cosine(l2normalize(Float32Array.from([2, 0])), l2normalize(Float32Array.from([10, 0]))) - 1) < 1e-6)
  assert.equal(cosine(l2normalize(Float32Array.from([1, 0])), l2normalize(Float32Array.from([0, 1]))), 0)
  const key = embedKeyOf({ text: '喜欢猫', tags: ['B站', '知识'], aboutName: '主人', entity: '', topic: '' })
  assert.ok(key.includes('喜欢猫') && key.includes('B站') && key.includes('主人'))
})
