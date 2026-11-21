// 向量通道（1.4.4）：配置门控的语义召回。BM25 对「查询与记忆没有共同字词」的纯语义提问，
// 只有 21 个手写概念桶兜底（memory-concepts.js），盖不住 B 站/抖音带回来的长尾话题；
// 同义改写（「喜欢猫」vs「爱养猫」）的二元字组 Jaccard 也判不出重复。本模块给每条记忆补一个
// embedding，召回时与 BM25 做双通道 RRF 融合（只重排、不扩可见性），cross-encoder 精排留作下一步。
//
// 为什么默认关：公开插件包不能拖 onnxruntime（~100MB），DSH 也未暴露 /embeddings
// （modules/API.md 无此能力）。启用 = 用户自备一个 OpenAI 兼容的 embeddings 端点
// （如 SiliconFlow 的 BAAI/bge-m3），配置在 memory.embeddings。未启用时 enabled() 恒 false，
// 所有调用点短路，行为与 1.4.3 完全一致（回归面为零）。
//
// 规模账（2026-11-14 决策记录）：单作用域 ≤500 条（SCOPE_QUOTAS），1024 维全量 float32 ≈2MB，
// 暴力余弦毫秒级 —— 不引入向量库 / HNSW。vectors.bin 与 memory.md 同目录落盘，复用原子写。
//
// 失败哲学：这里的一切错误都不许往召回路径抛 —— 向量通道挂了最多退回纯 BM25，
// 绝不能砸了回复。对外 async 方法统一吞错 + 限频告警。

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeTextAtomic, scopeToVecFilePath } from './memory-files.js'

const VEC_FORMAT = 'qqhub-vectors-v1'
const QUERY_CACHE_TTL = 5 * 60_000
const QUERY_CACHE_MAX = 50
const FLUSH_DEBOUNCE_MS = 15_000
const WARN_INTERVAL_MS = 5 * 60_000

const sha16 = (s) => createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 16)

// ---------------- 配置 ----------------

/** 归一化 memory.embeddings 配置。没启用或没填合法 url 返回 null（调用点按「通道不存在」处理）。 */
export function normalizeEmbeddingConfig(memCfg = {}) {
  const e = memCfg && typeof memCfg === 'object' ? memCfg.embeddings : null
  if (!e || typeof e !== 'object' || e.enabled !== true) return null
  const url = String(e.url || '').trim()
  if (!url || !/^https?:\/\//.test(url)) return null
  return {
    url,
    apiKey: String(e.apiKey || '').trim(),
    model: String(e.model || '').trim() || 'BAAI/bge-m3',
    dim: Math.max(64, Math.min(4096, Math.round(Number(e.dim) || 1024))),
    timeoutMs: Math.max(1000, Math.min(60000, Math.round(Number(e.timeoutMs) || 8000))),
    batch: Math.max(1, Math.min(64, Math.round(Number(e.batch) || 16))),
    maxChars: Math.max(60, Math.min(400, Math.round(Number(e.maxChars) || 200))), // 单条送 embed 的截断（add() 的 text 上限本来就是 200）
  }
}

/** 参与 embed 的文本口径：正文 + 标签 + aboutName + 实体/话题槽位，与 buildIndex 的文档口径一致。 */
export function embedKeyOf(m) {
  return `${m.text || ''}\n${(m.tags || []).join(' ')}\n${m.aboutName || ''} ${m.entity || ''} ${m.topic || ''}`
}

// ---------------- embedding 客户端 ----------------

export function l2normalize(v) {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum)
  if (!n || !Number.isFinite(n)) return v
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** 两侧都已 L2 归一，点积即余弦。 */
export function cosine(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** OpenAI 兼容 /embeddings 客户端。fetchImpl 参数只为测试注入；生产用全局 fetch。 */
export function createEmbedder(cfg, { fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!cfg) return null
  async function embed(texts) {
    if (!texts || !texts.length) return []
    const clipped = texts.map((t) => String(t || '').slice(0, cfg.maxChars))
    const out = []
    for (let i = 0; i < clipped.length; i += cfg.batch) {
      const chunk = clipped.slice(i, i + cfg.batch)
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: chunk, encoding_format: 'float' }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
      const data = await res.json()
      const rows = Array.isArray(data?.data) ? data.data : null
      if (!rows || rows.length !== chunk.length) throw new Error('embeddings 返回结构不符合预期')
      for (const row of rows) {
        const v = Float32Array.from(row.embedding || [])
        if (v.length !== cfg.dim) throw new Error(`embedding 维度不符：期望 ${cfg.dim}，拿到 ${v.length}`)
        out.push(l2normalize(v))
      }
    }
    return out
  }
  return { embed, log }
}

// ---------------- RRF 融合（纯函数，可单测） ----------------

/**
 * BM25 与向量两通道的排名倒数融合（k=60）。只用排名不用原始分 ——
 * 两边分数量纲不同（BM25 是 tf-idf 加权和，向量是余弦×重要度权重），直接加权会互相污染。
 * 约定：两个通道的候选都已经过 scope/persona/invalid 过滤，融合只重排、不扩可见性。
 */
export function fuseRrf(bm25Hits, vecHits, { k = 60, limit = 8 } = {}) {
  const byId = new Map()
  const add = (list, tag) => {
    (list || []).forEach((h, i) => {
      const id = String(h.it.id)
      const e = byId.get(id) || { hit: h, fused: 0, channels: [] }
      e.fused += 1 / (k + i + 1)
      if (!e.channels.includes(tag)) e.channels.push(tag)
      byId.set(id, e)
    })
  }
  add(bm25Hits, 'bm25')
  add(vecHits, 'vector')
  return [...byId.values()]
    .sort((a, b) => b.fused - a.fused || (a.channels.includes('bm25') ? -1 : 1))
    .slice(0, Math.max(1, limit))
    .map((e) => {
      const why = [...(e.hit.why || [])]
      if (e.channels.includes('vector') && !why.some((w) => String(w).includes('语义'))) why.push('（语义召回）')
      return { ...e.hit, score: e.fused, why }
    })
}

// ---------------- 作用域向量文件 ----------------
// vectors.bin 格式：首行 JSON 头 {"format":"qqhub-vectors-v1","dim":N,"ids":[...],"hashes":[...]}，
// 之后按 ids 顺序紧排 float32（小端）。hashes 是 embedKeyOf 的 sha16 —— 条目文本改了（revise/补证据）
// 靠它判定向量失效。条目 ≤500/作用域，整文件全量重建的成本可忽略。

export function createScopeVectorFile(filePath, dim, { log = console } = {}) {
  let cache = null // { mtimeMs, size, map: Map<id, { vec, hash }> }

  function load() {
    let st = null
    try { st = statSync(filePath) } catch { return new Map() }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.map
    try {
      const buf = readFileSync(filePath)
      const nl = buf.indexOf(0x0a)
      const head = JSON.parse(buf.subarray(0, nl).toString('utf8'))
      if (head.format !== VEC_FORMAT || Number(head.dim) !== dim) throw new Error('format/dim 不符')
      const ids = Array.isArray(head.ids) ? head.ids : []
      const hashes = Array.isArray(head.hashes) ? head.hashes : []
      const body = buf.subarray(nl + 1)
      const map = new Map()
      for (let i = 0; i < ids.length; i++) {
        const off = i * dim * 4
        if (off + dim * 4 > body.length) break
        const vec = new Float32Array(dim)
        for (let j = 0; j < dim; j++) vec[j] = body.readFloatLE(off + j * 4)
        map.set(String(ids[i]), { vec, hash: String(hashes[i] || '') })
      }
      cache = { mtimeMs: st.mtimeMs, size: st.size, map }
      return map
    } catch (error) {
      log?.warn?.(`vectors.bin 解析失败（按无向量处理，不影响 BM25）：${filePath}: ${error.message}`)
      cache = { mtimeMs: st.mtimeMs, size: st.size, map: new Map() }
      return cache.map
    }
  }

  function save(map) {
    const ids = []
    const hashes = []
    const vecs = []
    for (const [id, e] of map) {
      ids.push(id)
      hashes.push(e.hash || '')
      vecs.push(e.vec)
    }
    const head = JSON.stringify({ format: VEC_FORMAT, dim, ids, hashes })
    const body = Buffer.alloc(vecs.length * dim * 4)
    for (let i = 0; i < vecs.length; i++) {
      const v = vecs[i]
      for (let j = 0; j < dim; j++) body.writeFloatLE(v[j] || 0, i * dim * 4 + j * 4)
    }
    writeTextAtomic(filePath, Buffer.concat([Buffer.from(head + '\n', 'utf8'), body]))
    cache = null // 下次 load 重新 stat
  }

  /** 暴力余弦 top-K。whitelist 是允许参与的 id 集合 —— scope/persona/invalid 过滤由调用方先做完。 */
  function search(qv, whitelist, topK = 10) {
    const map = load()
    const scored = []
    for (const [id, e] of map) {
      if (whitelist && !whitelist.has(id)) continue
      scored.push({ id, cos: cosine(qv, e.vec) })
    }
    scored.sort((a, b) => b.cos - a.cos)
    return scored.slice(0, Math.max(1, topK))
  }

  return { load, save, search, path: filePath }
}

// ---------------- 通道编排 ----------------

// flushDebounceMs 可注入：测试要观察「保存 → 对账落盘」的最终效果，15s 防抖
// 会让用例挂太久；生产默认不变。
export function createVectorChannel({ memoryDir, getConfig, log = console, fetchImpl, now = Date.now, flushDebounceMs = FLUSH_DEBOUNCE_MS } = {}) {
  const cfgOf = () => normalizeEmbeddingConfig(getConfig && getConfig()?.memory)
  // 审计 S13 复核：停用是**不可逆**状态。过去 dispose() 只清 timer/dirty，在途请求
  // 迟到的失败处理、以及 finally 里补的调度都不看它——停用后还能把旧 pending 写回
  // dirty，再安排一次 flush，把记忆正文重新提交到 embedding 端点。
  // 所有入队/落盘入口统一看这个闸。
  let disposed = false
  let lastWarn = 0
  const warnOnce = (msg) => {
    const t = now()
    if (t - lastWarn > WARN_INTERVAL_MS) { lastWarn = t; log?.warn?.(`向量通道：${msg}`) }
  }

  const files = new Map() // scope -> createScopeVectorFile(...)
  const fileOf = (scope) => {
    const cfg = cfgOf()
    if (!cfg || !memoryDir) return null
    if (!files.has(scope)) {
      files.set(scope, createScopeVectorFile(join(memoryDir, scopeToVecFilePath(scope)), cfg.dim, { log }))
    }
    return files.get(scope)
  }

  // 待处理对账队列：scope -> Map<id, embedKey>（save 时全量入队，flush 时只补缺失/文本变更的）
  const dirty = new Map()
  let flushTimer = null
  let flushing = false

  const enabled = () => !disposed && Boolean(cfgOf())

  /** save() 后调用：整个作用域对账入队（防抖后批量 embed 缺失/变更条目、摘除已死条目的向量）。 */
  function queueScope(scope, items) {
    if (disposed || !enabled()) return
    // 审计 S13 附带：这里的语义是「整作用域对账快照」——每次调用都是该 scope 的
    // **全量**存活清单（save() 传现存条目；清空时传空数组=全摘除）。
    // 过去复用 dirty 里已有的 Map 且只增不减：连续两次 remove（第二次删空作用域、
    // 传空数组）时，第一次留下的 key 仍在，空对账退化成部分对账，死向量残留。
    // 改为每次新建 pend 覆盖。
    const pend = new Map()
    for (const m of items || []) {
      if (!m || m.invalidAt) continue // 死条目不入队；flush 时对账会顺手把旧向量摘掉
      pend.set(String(m.id), embedKeyOf(m))
    }
    dirty.set(scope, pend)
    scheduleFlush()
  }

  function scheduleFlush() {
    if (disposed || flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush().catch(() => {})
    }, Math.max(0, Number(flushDebounceMs) || 0))
    flushTimer.unref?.()
  }

  async function flush() {
    const cfg = cfgOf()
    const emb = cfg ? createEmbedder(cfg, { fetchImpl, log }) : null
    // 停用后不再发起任何 embedding 请求（包括被 finally 重新调度的这一轮）
    if (disposed || !cfg || !emb || flushing || !dirty.size) return 0
    flushing = true
    let embedded = 0
    try {
      const batches = [...dirty]
      dirty.clear()
      for (const [scope, pend] of batches) {
        // 中止后（停用/期间被 dispose）不再碰这个 scope，pending 已经由 dispose 清空
        if (disposed) break
        try {
          const file = fileOf(scope)
          if (!file) continue
          // 审计 S13 复核：**事务化**。file.load() 返回的是模块内缓存的同一个 Map，
          // 过去直接在它上面 pruned / set 再分批 await —— 一旦中途某批失败，
          // 前面成功的批已经改在这个共享缓存里，磁盘却没写；随后 save() 的新快照
          // 覆盖 dirty，下一次 flush 看到「缓存已是最新」（need/pruned 均 0）直接
          // 跳过 file.save()，于是那部分成功永远落不了盘，旧向量一直留在磁盘上。
          // 现在所有改动都做在私有副本上，全部批次成功后才提交缓存与磁盘。
          const map = new Map(file.load())
          // 对账：只留还活着的条目（被遗忘/清空/搬走作用域的自动摘除向量）。
          // 只能有这一个摘除循环并如实计 pruned：旧版前面还有一个先删尽死 id 的循环，
          // 使这里 pruned 恒 0 → 纯摘除的 flush 命中下方 continue 永不 save，
          // 磁盘只涨不清、状态失真、重启后死向量复活回灌候选池。
          const need = []
          let pruned = 0
          for (const id of [...map.keys()]) if (!pend.has(id)) { map.delete(id); pruned++ }
          for (const [id, key] of pend) {
            const cur = map.get(id)
            if (!cur || cur.hash !== sha16(key)) need.push({ id, key })
          }
          if (!need.length && !pruned) continue // 没有新增/变更/摘除就不重写文件
          let committed = 0
          for (let i = 0; i < need.length; i += cfg.batch) {
            const chunk = need.slice(i, i + cfg.batch)
            const vecs = await emb.embed(chunk.map((x) => x.key))
            if (disposed) throw new Error('向量通道已停用')
            chunk.forEach((x, j) => map.set(x.id, { vec: vecs[j], hash: sha16(x.key) }))
            committed += chunk.length
          }
          // 全部批次成功：写盘，并把整份结果提交回共享缓存
          file.save(map)
          embedded += committed
        } catch (error) {
          if (disposed) break // 停用导致的失败不重排、不回填，也不再发请求
          warnOnce(`flush 失败（退回纯 BM25，稍后重试）：${error.message}`)
          // 回填时也要保留「本次快照要求摘除」的语义：只回填存活条目，
          // 这样下一次 flush 的对账仍会摘掉已死的向量。
          const back = dirty.get(scope) || new Map()
          for (const [id, key] of pend) if (!back.has(id)) back.set(id, key)
          dirty.set(scope, back)
        }
      }
    } finally {
      flushing = false
      // 审计 S13 附带：flush 飞行期间入队的 scope 会被上面的 flushing 卫语句
      // 直接 return 掉——dirty 里留着数据、却没有任何定时器再去碰它，要等
      // 下一次任意 save 才有机会 flush。连续两次 remove（第二次删空作用域）
      // 正好踩中：空对账被吞，死向量残留。finally 里补一次调度兜底。
      if (!disposed && dirty.size) scheduleFlush()
    }
    return embedded
  }

  const qCache = new Map() // sha16(query) -> { vec, at }
  /** 查询向量（带 5 分钟 TTL 缓存）。timeoutMs 是独立于 HTTP 超时的兜底 —— 召回路径等不起。 */
  async function embedQuery(text, { timeoutMs = 3000 } = {}) {
    if (disposed) return null
    const cfg = cfgOf()
    const emb = cfg ? createEmbedder(cfg, { fetchImpl, log }) : null
    if (!cfg || !emb) return null
    const key = sha16(String(text || ''))
    const hit = qCache.get(key)
    if (hit && now() - hit.at < QUERY_CACHE_TTL) return hit.vec
    const vec = await Promise.race([
      emb.embed([String(text || '').slice(0, cfg.maxChars)]).then((v) => v && v[0]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('embedQuery 兜底超时')), timeoutMs)),
    ])
    if (!vec) return null
    qCache.set(key, { vec, at: now() })
    if (qCache.size > QUERY_CACHE_MAX) qCache.delete(qCache.keys().next().value)
    return vec
  }

  /**
   * 多作用域语义召回。whitelistOf(scope) 返回该作用域允许参与的 id 集合
   * （调用方从 indexFor(scope) 取 —— 那里已经做完 invalid 过滤；persona 在调用方再过一遍）。
   */
  async function searchScopes(queryText, scopes, { whitelistOf, topK = 12, timeoutMs = 3000 } = {}) {
    const cfg = cfgOf()
    if (!cfg) return []
    const qv = await embedQuery(queryText, { timeoutMs })
    if (!qv) return []
    const out = []
    for (const scope of scopes || []) {
      const file = fileOf(scope)
      if (!file) continue
      let wl = null
      try { wl = whitelistOf ? whitelistOf(scope) : null } catch { wl = null }
      for (const h of file.search(qv, wl, topK)) out.push({ scope: String(scope), id: h.id, cos: h.cos })
    }
    return out.sort((a, b) => b.cos - a.cos)
  }

  /** 面板手动触发：把传入条目按 scope 分组强推入队（只补缺失/文本变更的；要全量重建先删 vectors.bin）。 */
  async function backfill(items) {
    if (disposed) return { ok: false, message: '向量通道已停用' }
    if (!enabled()) return { ok: false, message: '向量通道未启用：面板「记忆」页模块设置或 memory.embeddings' }
    const byScope = new Map()
    for (const m of items || []) {
      if (!m || m.invalidAt) continue
      const sc = String(m.scope || '').trim()
      if (!sc) continue
      const pend = byScope.get(sc) || new Map()
      pend.set(String(m.id), embedKeyOf(m))
      byScope.set(sc, pend)
    }
    for (const [sc, pend] of byScope) dirty.set(sc, pend)
    const embedded = await flush()
    return { ok: true, embedded: embedded || 0 }
  }

  function status() {
    const cfg = cfgOf()
    if (!cfg) return { enabled: false }
    let scopes = 0
    let vectors = 0
    for (const scope of files.keys()) {
      const file = files.get(scope)
      if (!file) continue
      try {
        scopes++
        vectors += file.load().size
      } catch {}
    }
    return { enabled: true, model: cfg.model, dim: cfg.dim, scopes, vectors, pending: dirty.size }
  }

  /** 关闭通道（同步且幂等）。置 disposed 后所有入口都不再发请求、不再写盘。 */
  function dispose() {
    disposed = true
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    dirty.clear()
    qCache.clear()
    files.clear()
  }

  return { enabled, queueScope, flush, embedQuery, searchScopes, backfill, status, dispose }
}
