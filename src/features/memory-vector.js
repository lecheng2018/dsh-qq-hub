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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
  async function embed(texts, { signal } = {}) {
    if (!texts || !texts.length) return []
    const clipped = texts.map((t) => Array.from(String(t || '').toWellFormed()).slice(0, cfg.maxChars).join(''))
    const out = []
    for (let i = 0; i < clipped.length; i += cfg.batch) {
      const chunk = clipped.slice(i, i + cfg.batch)
      const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs)
      const reqSignal = signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : signal)
        : timeoutSignal
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: chunk, encoding_format: 'float' }),
        signal: reqSignal,
      })
      if (!res.ok) {
        const body = await (typeof res.text === 'function' ? res.text() : Promise.resolve('')).catch(() => '')
        const error = new Error(`embeddings HTTP ${res.status}${body ? `: ${String(body).slice(0, 160)}` : ''}`)
        // 带上状态码：401/403/402 不是「等一下就好」的故障，重试只会白烧额度/继续 401
        error.status = Number(res.status) || 0
        throw error
      }
      const data = await res.json()
      const rows = Array.isArray(data?.data) ? data.data : null
      if (!rows || rows.length !== chunk.length) throw new Error('embeddings 返回结构不符合预期')
      for (const row of rows) {
        const v = Float32Array.from(row.embedding || [])
        if (v.length !== cfg.dim) {
          // 维度不符是配置错（模型/dim 不匹配），重试一万次也不会变对 → 标记为不可自愈
          const error = new Error(`embedding 维度不符：期望 ${cfg.dim}，拿到 ${v.length}`)
          error.code = 'EMBED_DIM_MISMATCH'
          throw error
        }
        out.push(l2normalize(v))
      }
    }
    return out
  }
  return { embed, log }
}

/** 不可靠重试自愈的 embedding 失败：鉴权失败(401)、欠费(402)、无权限(403)、维度/模型配置不符。 */
export function isFatalEmbeddingError(error) {
  if (!error) return false
  if (error.code === 'EMBED_DIM_MISMATCH') return true
  const status = Number(error.status) || 0
  if (status === 401 || status === 402 || status === 403) return true
  const text = String(error.message || '')
  // 错误被别的层包过（只剩消息）时也要认出来：403 的常见文案是 invalid api key / quota
  return /\bHTTP (401|402|403)\b/.test(text) || /维度(不符|不匹配)/.test(text)
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
  function search(qv, whitelist, topK = 10, minCos = 0) {
    const map = load()
    const floor = Number.isFinite(Number(minCos)) ? Number(minCos) : 0
    const scored = []
    for (const [id, e] of map) {
      if (whitelist && !whitelist.has(id)) continue
      const cos = cosine(qv, e.vec)
      if (floor > 0 && cos < floor) continue
      scored.push({ id, cos })
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

  // 以规范相对向量路径（scopeToVecFilePath）为键，消除 qq:<id> / private:<id> 等别名缓存分裂
  const files = new Map() // vecRelPath -> { dim, file }
  const fileByRel = (rel) => {
    const cfg = cfgOf()
    if (!cfg || !memoryDir || !rel) return null
    const cached = files.get(rel)
    if (!cached || cached.dim !== cfg.dim) {
      const file = createScopeVectorFile(join(memoryDir, rel), cfg.dim, { log })
      files.set(rel, { dim: cfg.dim, file })
      return file
    }
    return cached.file
  }
  const fileOf = (scope) => fileByRel(scopeToVecFilePath(scope))

  // 待处理对账队列：vecRelPath -> Map<id, embedKey>（save 时全量入队，flush 时只补缺失/文本变更的）
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
    const rel = scopeToVecFilePath(scope)
    const pend = new Map()
    for (const m of items || []) {
      if (!m || m.invalidAt) continue // 死条目不入队；flush 时对账会顺手把旧向量摘掉
      pend.set(String(m.id), embedKeyOf(m))
    }
    dirty.set(rel, pend)
    scheduleFlush()
  }

  // T3.8：连续失败退避 —— 网关/额度故障时不要每 flushDebounceMs 就打一次 embedding。
  const MAX_AUTO_RETRIES = 5
  let failStreak = 0
  function nextFlushDelayMs() {
    const base = Math.max(0, Number(flushDebounceMs) || 0)
    if (failStreak <= 0) return base
    // 1 次失败 → 2×，2 次 → 4× …… 上限 5 分钟
    return Math.min(Math.max(base, 1000) * Math.pow(2, Math.min(failStreak, 8)), 5 * 60_000)
  }

  function scheduleFlush() {
    if (disposed || flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush().catch(() => {})
    }, nextFlushDelayMs())
    flushTimer.unref?.()
  }

  async function flush() {
    const cfg = cfgOf()
    const emb = cfg ? createEmbedder(cfg, { fetchImpl, log }) : null
    // 停用后不再发起任何 embedding 请求（包括被 finally 重新调度的这一轮）
    if (disposed || !cfg || !emb || flushing || !dirty.size) return 0
    flushing = true
    let embedded = 0
    let fatalStop = false
    try {
      const batches = [...dirty]
      dirty.clear()
      for (const [rel, pend] of batches) {
        // 中止后（停用/期间被 dispose）不再碰这个 scope，pending 已经由 dispose 清空
        if (disposed) break
        try {
          const file = fileByRel(rel)
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
          // 401/403/402/维度不符：直接打满重试上限立刻停排（否则要白等 5 轮指数退避 + 继续 401）
          fatalStop = fatalStop || isFatalEmbeddingError(error)
          failStreak = fatalStop ? MAX_AUTO_RETRIES : failStreak + 1 // 连续失败 → 下一次调度延迟按 2^n 退避（见 nextFlushDelayMs）
          warnOnce(`flush 失败（退回纯 BM25，稍后重试）：${error.message}`)
          // T3.8：回填必须尊重「失败期间又来了新快照」的事实。
          // queueScope 的语义是整作用域全量对账，新快照（尤其是 [] 删空）一旦入队，
          // 旧的 pend 就已经作废 —— 若照旧回填，会把刚被删掉的 ID 复活进 dirty，
          // 下一轮又把死向量重新写回磁盘。
          if (!dirty.has(rel)) {
            const back = new Map()
            for (const [id, key] of pend) back.set(id, key)
            dirty.set(rel, back)
          }
        }
      }
    } finally {
      flushing = false
      // 本轮有成功批次才清零；不可自愈的致命错误即使前面侥幸成功过也不许清零（否则又开始无限重试）
      if (embedded > 0 && !fatalStop) failStreak = 0
      // 审计 S13 附带：flush 飞行期间入队的 scope 会被上面的 flushing 卫语句
      // 直接 return 掉——dirty 里留着数据、却没有任何定时器再去碰它，要等
      // 下一次任意 save 才有机会 flush。连续两次 remove（第二次删空作用域）
      // 正好踩中：空对账被吞，死向量残留。finally 里补一次调度兜底。
      // T3.8：连续失败达到上限后停止自动重排（避免对 401/欠费/宕机无限重试），
      // 但下一次 queueScope/backfill 仍会正常触发（failStreak 只在 flush 内累加）。
      if (!disposed && dirty.size && failStreak < MAX_AUTO_RETRIES) scheduleFlush()
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
    const clipped = Array.from(String(text || '').toWellFormed()).slice(0, cfg.maxChars).join('')
    const key = sha16(`${cfg.dim}:${cfg.model}:${clipped}`)
    const hit = qCache.get(key)
    if (hit && now() - hit.at < QUERY_CACHE_TTL) return hit.vec
    const ac = new AbortController()
    let timer = null
    try {
      const timeoutPromise = new Promise((_, rej) => {
        timer = setTimeout(() => {
          const err = new Error('embedQuery 兜底超时')
          ac.abort(err)
          rej(err)
        }, timeoutMs)
        timer.unref?.()
      })
      const vec = await Promise.race([
        emb.embed([clipped], { signal: ac.signal }).then((v) => v && v[0]),
        timeoutPromise,
      ])
      if (!vec) return null
      qCache.set(key, { vec, at: now() })
      if (qCache.size > QUERY_CACHE_MAX) qCache.delete(qCache.keys().next().value)
      return vec
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 多作用域语义召回。whitelistOf(scope) 返回该作用域允许参与的 id 集合
   * （调用方从 indexFor(scope) 取 —— 那里已经做完 invalid 过滤；persona 在调用方再过一遍）。
   */
  async function searchScopes(queryText, scopes, { whitelistOf, topK = 12, timeoutMs = 3000, minCos = 0 } = {}) {
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
      for (const h of file.search(qv, wl, topK, minCos)) out.push({ scope: String(scope), id: h.id, cos: h.cos })
    }
    return out.sort((a, b) => b.cos - a.cos)
  }

  function scanVectorRelPaths() {
    const out = []
    if (!memoryDir || !existsSync(memoryDir)) return out
    function walk(dir, relPrefix) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (!relPrefix && (ent.name === 'quarantine' || ent.name === 'backup')) continue
          walk(join(dir, ent.name), relPrefix ? join(relPrefix, ent.name) : ent.name)
        } else if (ent.isFile() && ent.name === 'vectors.bin' && relPrefix) {
          out.push(join(relPrefix, 'vectors.bin'))
        }
      }
    }
    try { walk(memoryDir, '') } catch {}
    return out
  }

  /**
   * 面板手动触发：补全全库存活条目向量，并同步对账清理孤儿作用域的死向量。
   * 注意：items 须为全库各作用域的完整存活快照（如 memory.list('')），缺席的作用域会被视为已清空而摘除向量。
   */
  async function backfill(items) {
    if (disposed) return { ok: false, message: '向量通道已停用' }
    if (!enabled()) return { ok: false, message: '向量通道未启用：面板「记忆」页模块设置或 memory.embeddings' }
    const byRel = new Map()
    for (const m of items || []) {
      if (!m || m.invalidAt) continue
      const sc = String(m.scope || '').trim()
      if (!sc) continue
      const rel = scopeToVecFilePath(sc)
      const pend = byRel.get(rel) || new Map()
      pend.set(String(m.id), embedKeyOf(m))
      byRel.set(rel, pend)
    }
    // 向量关闭期间被删空的作用域，或启动前遗留的孤儿 vectors.bin（含 custom/），补全时一并入队空对账摘除死向量
    for (const rel of new Set([...files.keys(), ...scanVectorRelPaths()])) {
      if (!byRel.has(rel)) dirty.set(rel, new Map())
    }
    for (const [rel, pend] of byRel) dirty.set(rel, pend)
    const embedded = await flush()
    return { ok: true, embedded: embedded || 0 }
  }

  function status() {
    const cfg = cfgOf()
    if (!cfg) return { enabled: false }
    let scopes = 0
    let vectors = 0
    for (const scope of files.keys()) {
      const entry = files.get(scope)
      const file = entry?.file
      if (!file) continue
      try {
        scopes++
        vectors += file.load().size
      } catch {}
    }
    // failing：连续失败计数（面板可观测；达到上限即自动停排，等下次 save/backfill 再试）
    return { enabled: true, model: cfg.model, dim: cfg.dim, scopes, vectors, pending: dirty.size, failing: failStreak }
  }

  /** 关闭通道（同步且幂等）。置 disposed 后所有入口都不再发请求、不再写盘。 */
  function dispose() {
    disposed = true
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    dirty.clear()
    qCache.clear()
    files.clear()
  }

  return {
    enabled, queueScope, flush, embedQuery, searchScopes, backfill, status, dispose,
    // 观测/测试用：连续失败次数与下一次调度延迟（退避是否生效）
    failStreak: () => failStreak,
    nextFlushDelayMs: () => nextFlushDelayMs(),
    hasFlushTimer: () => Boolean(flushTimer),
    pendingIds: () => [...dirty.entries()].flatMap(([, m]) => [...m.keys()]),
  }
}
