// 上下文与费用遥测（只观察，绝不改变行为）。
//
// 参考 surfcore 的 src/context-telemetry.js + token-budget.js（MIT，docs/reference/ 有存档）。
// 但数据源不同：它是独立桥接进程自己记账；我们是 DSH 进程内插件，
// 直接从 `assistant/message` 事件的 `usage` 字段拿**厂商上报的真实用量**
// （uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）。
//
// 设计边界（照抄它的自律）：
//   · 只写旁路 JSONL，不修改 prompt、工具可见性、会话策略、任何闸门阈值；
//   · 不记录消息正文、工具参数原文、密钥 —— 只记长度、数量、模型、usage；
//   · 每个字段区分 observed / estimated，拿不到就写 null，不冒充实测；
//   · 写入失败不能影响 QQ / DSH 主链路（全 try/catch）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const TELEMETRY_VERSION = 1
export const TELEMETRY_MAX_BYTES = 4 * 1024 * 1024 // 超了轮转成 .1，只留一份历史

/** 各家模型的大致单价（元 / 百万 token）。用户可覆盖，默认值仅供参考，不承诺精确。 */
export const DEFAULT_PRICES = Object.freeze({
  'deepseek-v4.1-flash': { input: 0.5, cacheRead: 0.1, output: 2 },
  'glm-5.3-flash': { input: 0.5, cacheRead: 0.1, output: 2 },
  'MiniMax-M3.1-Flash': { input: 0.15, cacheRead: 0.015, output: 0.6 },
  'gemini-3.8-flash-high': { input: 0.1, cacheRead: 0.01, output: 0.4 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, output: 15 },
  'claude-opus-4-6-thinking': { input: 15, cacheRead: 1.5, output: 75 },
  'gpt-oss-120b-medium': { input: 0.5, cacheRead: 0.05, output: 2 },
})

/** 从 usage 记录里取出四个计数；unreported 的填 0 并在 observed 里标 false。 */
export function normalizeUsage(usage) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const input = num(usage && usage.uncachedInputTokens)
  const output = num(usage && usage.outputTokens)
  const cacheRead = num(usage && usage.cacheReadTokens)
  const cacheWrite = num(usage && usage.cacheWriteTokens)
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total: (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    observed: {
      input: input !== null, output: output !== null,
      cacheRead: cacheRead !== null, cacheWrite: cacheWrite !== null,
    },
  }
}

/** 按单价算一次调用的花费（元）。没有该模型单价就返回 null，不瞎估。 */
export function costOf(usage, model, prices = DEFAULT_PRICES) {
  const u = normalizeUsage(usage)
  const p = prices && prices[model]
  if (!p) return null
  const per = 1_000_000
  return (u.input * (p.input || 0)
    + u.cacheRead * (p.cacheRead ?? p.input ?? 0)
    + u.cacheWrite * (p.cacheWrite ?? p.input ?? 0)
    + u.output * (p.output || 0)) / per
}

const dayKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 建一个遥测记录器。
 * @param {{dir:()=>string, log?:object, enabled?:()=>boolean, prices?:()=>object}} opts
 */
export function createTelemetry({ dir, log, enabled = () => true, prices = () => DEFAULT_PRICES } = {}) {
  const fileOf = () => join(dir(), 'telemetry.jsonl')

  function rotateIfNeeded() {
    try {
      const f = fileOf()
      if (!existsSync(f)) return
      if (statSync(f).size < TELEMETRY_MAX_BYTES) return
      renameSync(f, `${f}.1`)
    } catch (error) { /* 轮转失败不影响写入 */ }
  }

  /**
   * 记一条。**只在拿到 usage 时调用**（没上报就什么都不写，避免污染统计）。
   * @param {{sessionId?:string, chatId?:string, kind?:string, model?:string, provider?:string,
   *          usage:object, durationMs?:number, toolCalls?:number}} row
   */
  function record(row) {
    try {
      if (!enabled()) return
      if (!row || !row.usage) return
      const u = normalizeUsage(row.usage)
      if (u.total <= 0) return
      const cost = costOf(row.usage, row.model, prices())
      rotateIfNeeded()
      const d = dir()
      mkdirSync(d, { recursive: true })
      const line = {
        v: TELEMETRY_VERSION,
        at: Date.now(),
        day: dayKey(),
        sessionId: row.sessionId || '',
        chatId: row.chatId || '',
        kind: row.kind || 'chat', // chat | system | purpose | compact | summarize
        provider: row.provider || '',
        model: row.model || '',
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        total: u.total,
        observed: u.observed,
        costCny: cost === null ? null : Math.round(cost * 1e6) / 1e6,
        durationMs: Number.isFinite(row.durationMs) ? Math.round(row.durationMs) : null,
        toolCalls: Number.isFinite(row.toolCalls) ? Math.round(row.toolCalls) : null,
      }
      appendFileSync(fileOf(), `${JSON.stringify(line)}\n`, 'utf8')
    } catch (error) {
      try { log?.debug?.('遥测写入失败：', error.message) } catch {}
    }
  }

  /** 读最近 N 天的汇总（按天 + 按模型）。读不到就返回空，绝不抛。 */
  function summary({ days = 7, now = Date.now() } = {}) {
    const out = { days: [], byModel: {}, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costCny: 0, calls: 0 }, since: now - days * 86400_000 }
    try {
      const f = fileOf()
      if (!existsSync(f)) return out
      const text = readFileSync(f, 'utf8')
      const byDay = new Map()
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let r
        try { r = JSON.parse(line) } catch { continue }
        if (!r || Number(r.at) < out.since) continue
        const add = (bucket) => {
          bucket.input += Number(r.input) || 0
          bucket.output += Number(r.output) || 0
          bucket.cacheRead += Number(r.cacheRead) || 0
          bucket.cacheWrite += Number(r.cacheWrite) || 0
          bucket.total += Number(r.total) || 0
          bucket.costCny = Math.round((bucket.costCny + (Number(r.costCny) || 0)) * 1e6) / 1e6
          bucket.calls += 1
        }
        add(out.total)
        const dk = r.day || dayKey(r.at)
        if (!byDay.has(dk)) byDay.set(dk, { day: dk, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costCny: 0, calls: 0 })
        add(byDay.get(dk))
        const mk = `${r.provider || '?'}/${r.model || '?'}`
        if (!out.byModel[mk]) out.byModel[mk] = { model: mk, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costCny: 0, calls: 0 }
        add(out.byModel[mk])
      }
      out.days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
      out.byModel = Object.values(out.byModel).sort((a, b) => b.total - a.total)
      return out
    } catch (error) {
      try { log?.debug?.('遥测读取失败：', error.message) } catch {}
      return out
    }
  }

  return { record, summary, fileOf }
}
