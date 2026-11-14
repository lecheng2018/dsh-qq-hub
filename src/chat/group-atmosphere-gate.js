// 群聊张力门禁：把「读空气」（group-atmosphere）接到群闸主链上，当作 decideGroupReply 之前的一道情境闸。
//
// 为什么要有这一层：group-policy 只看关键词、相关度与频率刹车，看不见「群里正在吵」。
// 群里火药味正浓时她凑上去接一句，就是引战催化剂——这正是本门禁要拦的场景。
// 但刹车不能被削弱，所以决策链严格按计划书（v3.4-HARDENED 第七节）的顺序走：
//
//   1. 刹车检查：burst 溢出 → 主人 @ 豁免放行，其余直接拒绝（沿用 group-policy，口径一致）；
//   2. 强唤醒：被 @ / 被引用 / 叫到名字 → 无视张力，必须回复（mode: must）；
//   3. 张力门禁：tension > 0.7 → 静默（本文件新增的唯一一道闸）；
//   4. 其余 → 既有 decideGroupReply 的 maxPerHour / cooldownSec / quietHours / 相关度判定，原样生效。
//
// 第 1、2、4 步**不在这里重写**：直接调 group-policy 的 decideGroupReply，
// 连 reason 文案都保持同一份（改文案 = 改真机日志口径，会让人误以为行为变了）。
// 本模块只做两件事：读灰度开关（纯函数、fail-closed），以及在第 3 步插入张力判定。
//
// 纯函数、无 IO（开关由调用方把 env 传进来），同样的输入永远得到同样的决策。

import { DEFAULT_GROUP_POLICY, burstCount, decideGroupReply } from './group-policy.js'
import { DEFAULT_TENSION_LIMIT, evaluate } from './group-atmosphere.js'

/** 灰度开关的环境变量名。未设置 = 关闭 = legacy 行为。 */
export const ATMOSPHERE_GATE_ENV = 'QQHUB_GROUP_ATMOSPHERE_GATE'

// 只认这几个显式打开的词。其余（空串、乱码、数字、null、对象、拼错）一律当关闭：
// 张力门禁是「少说话」的闸，配置写错时退回 legacy 是安全的——不会因为一个 'ture'
// 让全群永久静音，也不会因为没配就悄悄开启。
const TRUTHY = new Set(['1', 'on', 'true', 'yes', 'enable', 'enabled'])
const FALSY = new Set(['', '0', 'off', 'false', 'no', 'disable', 'disabled'])

/**
 * 解析灰度开关。纯函数，不改 env。
 * @param {Record<string, string|undefined>} [env] 缺省 process.env
 * @returns {{enabled: boolean, raw: string|null, reason: string}}
 *   `raw` 是原始值（未设置时为 null），`reason` 说明为什么是这个结论，便于排障与日志。
 */
export function readAtmosphereGate(env = process.env) {
  let raw
  try { raw = env?.[ATMOSPHERE_GATE_ENV] } catch { raw = undefined }
  if (raw === undefined || raw === null) return { enabled: false, raw: null, reason: '未设置，按 legacy 处理' }
  if (typeof raw !== 'string') return { enabled: false, raw: null, reason: `非法类型（${typeof raw}），回退 legacy` }
  const v = raw.trim().toLowerCase()
  if (TRUTHY.has(v)) return { enabled: true, raw, reason: '显式开启' }
  if (FALSY.has(v)) return { enabled: false, raw, reason: '显式关闭' }
  // 空值/乱码：fail-closed 到 legacy。绝不把「说不准」当成「开」。
  return { enabled: false, raw, reason: `非法值「${raw}」，回退 legacy` }
}

/** 门禁配置归一：外部传进来的东西可能是任何类型，一律落到安全默认。 */
function normalizeGate(gate) {
  if (gate === true) return { enabled: true, tensionLimit: DEFAULT_TENSION_LIMIT }
  if (!gate || typeof gate !== 'object') return { enabled: false, tensionLimit: DEFAULT_TENSION_LIMIT }
  // 阈值只认 [0,1] 内的有限数。越界（-5 / 99）不夹逼而是直接回落默认 0.7：
  // 夹逼看着「宽容」，实则把 99 变成 1，等于把闸彻底关死（tension 永远 <= 1），
  // 配置写错反而静默失效——这不是 fail-closed。
  const limit = Number(gate.tensionLimit)
  const ok = Number.isFinite(limit) && limit >= 0 && limit <= 1
  return { enabled: gate.enabled === true, tensionLimit: ok ? limit : DEFAULT_TENSION_LIMIT }
}

/** 消息窗口：脏数据（null / 非数组 / 数组里的怪东西）由 group-atmosphere 自己兜底成空窗口。 */
function windowOf(p, options) {
  const raw = options?.messages ?? p?.messages
  try { return Array.isArray(raw) ? raw : [] } catch { return [] }
}

/**
 * 带张力门禁的群回复决策。返回形状与 decideGroupReply 完全一致
 * （`{reply, mode, reason}`），另外在门禁生效时挂一个 `atmosphere` 快照，便于日志与回放。
 *
 * @param {object} p 与 decideGroupReply 同一份入参（policy/mentioned/repliedToBot/fromOwner/
 *   text/now/botReplyTimes/hour/recentTimes/interjectTimes/relevance/engagedUntil/rand），
 *   外加可选 `messages`（本群最近的消息窗口，交给 group-atmosphere 读空气）。
 * @param {object} [options]
 * @param {object|boolean} [options.gate] `{enabled, tensionLimit}` 或 `true`（开着、默认阈值）
 * @param {Array} [options.messages] 覆盖 p.messages
 * @returns {{reply: boolean, mode: string, reason: string, atmosphere?: object}}
 */
export function decideGroupReplyWithAtmosphere(p, options = {}) {
  const params = p && typeof p === 'object' ? p : {}
  const gate = normalizeGate(options?.gate)
  const base = decideGroupReply(params)
  // 开关关着：直接把既有判定原样交出去，一个字段都不动（legacy 行为逐字节一致）。
  if (!gate.enabled) return base
  // 第 2 步已经判成 must（被 @ / 被引用 / 被叫到名字）：无视张力，必须回复。
  if (base.mode === 'must') return base
  // 第 1 步或第 4 步已经拒绝（burst 溢出 / 静默时段 / 冷却 / 每小时上限 / 相关度不够）：
  // 既有刹车先说话，张力不必再看，reason 也保持既有文案。
  if (!base.reply) return base

  const pol = params.policy || DEFAULT_GROUP_POLICY
  const now = Number.isFinite(params.now) ? params.now : Date.now()
  const atmosphere = evaluate(windowOf(params, options), { now, tensionLimit: gate.tensionLimit })
  if (atmosphere.tension > gate.tensionLimit) {
    return {
      reply: false,
      mode: 'none',
      reason: `群里在吵（张力 ${atmosphere.tension.toFixed(2)} > ${gate.tensionLimit}），这时候不插嘴`,
      atmosphere,
    }
  }
  return { ...base, atmosphere }
}

/** 供 host 装配处使用的一句话封装：读 env 得到开关 → 带门禁的决策。 */
export function gateFromEnv(env = process.env) {
  const gate = readAtmosphereGate(env)
  return { enabled: gate.enabled, tensionLimit: DEFAULT_TENSION_LIMIT, reason: gate.reason }
}

export { burstCount }
