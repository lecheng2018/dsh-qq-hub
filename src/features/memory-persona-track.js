// 双轨记忆 · 人设归属（personaId）纯函数工具（Phase 0b）。
//
// 职责（只增不改，零 I/O）：
//   1. 判定条目属于「主观自传轨」还是「客观事实轨」。
//   2. 规范化可选加法字段 personaId（非法/空值一律视为未标注）。
//   3. 提供读写两侧的纯函数：写入时给主观条目补 personaId、客观条目剥除；
//      读取时按当前激活人设过滤主观条目，客观事实永远可见。
//
// 兼容红线：
//   - 历史存量条目没有 personaId 时归属默认人设（dafeiyu），只读共享不丢弃。
//   - 旧版代码忽略未知字段 personaId，Markdown 事实源与 id/时间戳均不变。

export const DEFAULT_PERSONA_ID = 'dafeiyu'

/** 主观类（Affective Persona Memory）条目 kind 白名单 */
export const SUBJECTIVE_KINDS = Object.freeze(['insight', 'style', 'profile'])

const SUBJECTIVE_KIND_SET = new Set(SUBJECTIVE_KINDS)
const PERSONA_ID_MAX_LENGTH = 64
const PERSONA_ID_RE = /^[A-Za-z0-9_-]+$/

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 规范化 personaId；任何非法输入（null、数字、空串、超长、含非法字符）都返回 ''
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePersonaId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (!id || id.length > PERSONA_ID_MAX_LENGTH) return ''
  if (!PERSONA_ID_RE.test(id)) return ''
  return id
}

/**
 * 是否主观自传轨条目：kind 为 insight/style/profile，或带自身视角的非事实条目
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isSubjectiveEntry(entry) {
  if (!isRecord(entry)) return false
  const kind = String(entry.kind || '').trim()
  if (kind === 'fact') return false // 客观事实轨永不加 personaId（即使标了 selfView 亦强制为客观事实）
  if (SUBJECTIVE_KIND_SET.has(kind)) return true
  if (entry.selfView === true || entry.selfView === 1 || entry.perspective === 'self') return true
  if (entry.personaId) return true
  return false
}

/**
 * 条目自身声明的 personaId（未标注/非法时为 ''）
 */
export function entryPersonaId(entry) {
  return isRecord(entry) ? normalizePersonaId(entry.personaId) : ''
}

/**
 * 条目生效的 personaId：客观事实轨返回 ''；主观条目回落到默认人设
 */
export function effectivePersonaId(entry, defaultPersonaId = DEFAULT_PERSONA_ID) {
  if (!isSubjectiveEntry(entry)) return ''
  const fallback = normalizePersonaId(defaultPersonaId) || DEFAULT_PERSONA_ID
  return entryPersonaId(entry) || fallback
}

/**
 * 当前人设下条目是否可见：客观事实恒可见，主观条目仅同人设可见
 * @param {unknown} entry
 * @param {string} personaId 当前会话激活的 personaId（空则按默认人设处理）
 * @param {{ defaultPersonaId?: string }} [options]
 */
export function isEntryVisibleToPersona(entry, personaId, { defaultPersonaId = DEFAULT_PERSONA_ID } = {}) {
  if (!isSubjectiveEntry(entry)) return true
  const fallback = normalizePersonaId(defaultPersonaId) || DEFAULT_PERSONA_ID
  const active = normalizePersonaId(personaId) || fallback
  return effectivePersonaId(entry, fallback) === active
}

/**
 * 写入侧归一：主观条目补 personaId（条目已有值优先），客观条目剥除 personaId。
 * 纯函数：返回新对象，不修改入参。
 * @param {object} entry
 * @param {string} personaId 当前激活人设
 * @param {{ defaultPersonaId?: string }} [options]
 * @returns {object}
 */
export function withPersonaId(entry, personaId, { defaultPersonaId = DEFAULT_PERSONA_ID } = {}) {
  if (!isRecord(entry)) throw new TypeError('withPersonaId 需要对象条目')
  const next = { ...entry }
  if (isSubjectiveEntry(entry)) {
    const fallback = normalizePersonaId(defaultPersonaId) || DEFAULT_PERSONA_ID
    next.personaId = entryPersonaId(entry) || normalizePersonaId(personaId) || fallback
  } else {
    delete next.personaId
  }
  return next
}

/**
 * 批量写入侧归一：返回新数组 + 新对象，原数组与原条目不被修改。
 */
export function withPersonaIdAll(entries, personaId, options = {}) {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => withPersonaId(entry, personaId, options))
}

/**
 * 读取侧过滤：返回新数组 + 浅拷贝条目，调用方修改返回值不会污染存储内部状态。
 * 非数组输入返回空数组（fail-closed）。
 */
export function filterEntriesByPersona(entries, personaId, options = {}) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => isEntryVisibleToPersona(entry, personaId, options))
    .map((entry) => ({ ...entry }))
}
