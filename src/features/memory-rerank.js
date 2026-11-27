// Cross-encoder 精排（1.4.4，上游 v1.3.0-beta BGE reranker 语义移植）：
// RRF 融合之后的可选第二级排序。配置门控默认关；只重排 RRF 已召回的候选，
// 绝不扩大可见性（fail-closed 作用域隔离零改动）；任何失败退回 RRF 顺序（fail-open）。
// 协议：SiliconFlow 兼容 POST /rerank {model, query, documents, top_n}
//       → {results:[{index, relevance_score}]}。

const DEFAULT_URL = 'https://api.siliconflow.cn/v1/rerank'
const DEFAULT_MODEL = 'BAAI/bge-reranker-v2-m3'

/** 归一化精排分数阈值：null/false 表示显式关闭；有限数字或数字字符串生效；空白/布尔 true/非法值返回 undefined。 */
export function parseMinScore(value) {
  if (value === null || value === false) return null
  if (value === undefined || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 面板设置（ext.memory.rerank*）→ 归一配置；未开启/缺 key 返回 null。 */
export function normalizeRerankConfig(ext = {}) {
  const e = ext || {}
  if (e.rerankEnabled !== true) return null
  const apiKey = String(e.rerankApiKey || '').trim()
  if (!apiKey) return null
  const url = String(e.rerankUrl || '').trim() || DEFAULT_URL
  if (!/^https?:\/\//i.test(url)) return null
  const topN = Math.max(2, Math.min(50, Math.round(Number(e.rerankTopN) || 20)))
  const minScore = parseMinScore(e.rerankMinScore)
  return { url, apiKey, model: String(e.rerankModel || '').trim() || DEFAULT_MODEL, topN, minScore }
}

/**
 * 按 rerank 结果重排 hits 的前 topN 条（纯函数，可单测）。
 * results 里的 index 指向 documents（即前 topN 条）的下标；非法/越界/重复 index 丢弃，
 * 未被结果覆盖的候选保持原相对顺序排在重排块末尾；topN 之后的 hits 原样不动。
 * 若显式传入 minScore（如 0.05），被精排打分低于该阈值的明显无关候选会被剔除。
 */
export function applyRerankOrder(hits, results, topN, { minScore = null } = {}) {
  const list = Array.isArray(hits) ? hits : []
  const n = Math.max(0, Math.min(Number(topN) || 0, list.length))
  if (!n || !Array.isArray(results) || !results.length) return list
  const head = list.slice(0, n)
  const floor = typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : null
  const seen = new Set()
  const ranked = []
  const scored = results
    .filter((r) => r && Number.isInteger(r.index) && r.index >= 0 && r.index < n)
    .sort((a, b) => (Number(b.relevance_score) || 0) - (Number(a.relevance_score) || 0))
  for (const r of scored) {
    if (seen.has(r.index)) continue
    seen.add(r.index)
    const rel = Number(r.relevance_score) || 0
    if (floor !== null && rel < floor) continue
    ranked.push(head[r.index])
  }
  for (let i = 0; i < n; i += 1) if (!seen.has(i)) ranked.push(head[i])
  return [...ranked, ...list.slice(n)]
}

export function createReranker({ getConfig, log = console, fetchImpl = globalThis.fetch } = {}) {
  let lastError = ''
  const conf = () => {
    try {
      const c = getConfig() || {}
      return normalizeRerankConfig((c.ext && c.ext.memory) || {})
    } catch { return null }
  }
  function enabled() { return Boolean(conf()) }
  function status() {
    const c = conf()
    return { enabled: Boolean(c), model: c ? c.model : '', topN: c ? c.topN : 0, minScore: c ? c.minScore : undefined, lastError }
  }
  /** 精排只重排、不扩可见性；失败/超时/未启用一律原样返回（fail-open）。 */
  async function rerank(query, hits, { timeoutMs = 10000, minScore } = {}) {
    const c = conf()
    const list = Array.isArray(hits) ? hits : []
    const argFloor = parseMinScore(minScore)
    const rawFloor = argFloor !== undefined ? argFloor : (c ? c.minScore : undefined)
    const floor = typeof rawFloor === 'number' && Number.isFinite(rawFloor) ? rawFloor : null
    // 只有纯重排（未启用阈值下限）时才在少于 2 条时跳过；存在阈值过滤时单候选也需打分判无关
    if (!c || !list.length || (floor === null && list.length < 2)) return list
    const docs = list.slice(0, c.topN).map((h) => String((h && h.it && h.it.text) || ''))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({ model: c.model, query: String(query || ''), documents: docs, top_n: docs.length }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`rerank HTTP ${res.status}`)
      const data = await res.json()
      const out = applyRerankOrder(list, data && data.results, c.topN, { minScore: floor })
      lastError = ''
      return out
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 200)
      log?.warn?.(`记忆精排失败，退回 RRF 顺序：${lastError}`)
      return list
    } finally {
      clearTimeout(timer)
    }
  }
  return { enabled, status, rerank }
}
