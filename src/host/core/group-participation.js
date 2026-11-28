// 群参与分级（Batch 1 契约）：插件声明式接管结果的规范化与合流纯函数。
//
// 这里只做两件事：
//   · normalizeParticipation —— 把插件监听 group/participate 返回的值收敛成宿主白名单对象
//     （只保留 level / limits / reaction / sourceModuleId，其余字段一律丢弃）；
//     truthy 但结构无效时抛 ParticipationValidationError，调用方记警告并回退 FULL。
//   · mergeParticipation —— 同一回合（turnId）按入站顺序逐次合并多个成员的声明：
//     优先级 FULL > TEXT_LITE > REACT；任一成员模式是 must／engaged 时整回合强制 FULL
//     （must／engaged 永不降级），并清空 limits / reaction / sourceModuleId。
//
// 纯函数边界：不读全局配置、不发消息、不写文件、不调用模型；时间与随机一律由调用方注入。

export const PARTICIPATION_LEVELS = ['full', 'text_lite', 'react']

/** truthy 但结构无效时抛出：调用方靠 name／code 识别「校验失败→回退 FULL」，不与其它错误混淆。 */
export class ParticipationValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ParticipationValidationError'
    this.code = 'participation-invalid'
  }
}

const MESSAGE_ID_RE = /^[1-9][0-9]*$/
const EMOJI_ID_RE = /^[1-9][0-9]{0,9}$/
const isFiniteInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max

/**
 * 把插件的接管声明收敛成宿主白名单对象。
 * @param {unknown} value 监听器的返回值（undefined / null / false = 未接管）
 * @param {{ msg?: object, sourceModuleId?: string }} ctx msg 用来核对 reaction 锚点确是本条消息
 * @returns {null | { level: 'full'|'text_lite'|'react', sourceModuleId: string, limits?: object, reaction?: object }}
 * @throws {ParticipationValidationError} truthy 但结构无效
 */
export function normalizeParticipation(value, { msg, sourceModuleId } = {}) {
  if (!value) return null
  // truthy 但不是对象（如 'react'、数字）：按契约仍是接管（占用本次 claim），抛校验错误，
  // 调用方记警告并回退 FULL，绝不能当成「未接管」放走下一个监听器。
  if (Array.isArray(value)) throw new ParticipationValidationError('参与声明不能是数组')
  if (typeof value !== 'object') throw new ParticipationValidationError(`参与声明必须是对象：${JSON.stringify(String(value)).slice(0, 60)}`)
  const level = value.level
  if (!PARTICIPATION_LEVELS.includes(level)) {
    throw new ParticipationValidationError(`参与级别无效：${JSON.stringify(level ?? null)}`)
  }
  const out = { level, sourceModuleId: String(sourceModuleId || '') }
  if (level === 'text_lite') {
    const limits = value.limits
    if (limits !== undefined && limits !== null) {
      if (typeof limits !== 'object' || Array.isArray(limits)) throw new ParticipationValidationError('limits 必须是对象（数组无效）')
      const outLimits = {}
      if (limits.maxBubbles !== undefined) {
        if (!isFiniteInt(limits.maxBubbles, 1, 12)) throw new ParticipationValidationError(`maxBubbles 必须是 1~12 的有限整数：${JSON.stringify(limits.maxBubbles)}`)
        outLimits.maxBubbles = limits.maxBubbles
      }
      if (limits.maxChars !== undefined) {
        if (!isFiniteInt(limits.maxChars, 10, 500)) throw new ParticipationValidationError(`maxChars 必须是 10~500 的有限整数：${JSON.stringify(limits.maxChars)}`)
        outLimits.maxChars = limits.maxChars
      }
      if (Object.keys(outLimits).length) out.limits = outLimits
    }
    return out
  }
  if (level === 'react') {
    const reaction = value.reaction
    if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction)) throw new ParticipationValidationError('react 必须带 reaction 对象（数组无效）')
    const messageId = String(reaction.messageId ?? '')
    if (!MESSAGE_ID_RE.test(messageId)) throw new ParticipationValidationError(`messageId 非法：${JSON.stringify(reaction.messageId ?? null)}`)
    // 锚点校验不可跳过：缺 msg 或 msg.messageId 缺失时无从核对，一律拒绝（fail-closed），
    // 绝不允许「没传 msg 就当锚点合法」放行一个指向不明旧消息的 REACT。
    const currentMid = String(msg?.messageId ?? '')
    if (!currentMid || messageId !== currentMid) {
      throw new ParticipationValidationError(`reaction 锚点必须是当前消息：${messageId} ≠ ${currentMid || '(缺失)'}`)
    }
    const emojiId = String(reaction.emojiId ?? '')
    if (!EMOJI_ID_RE.test(emojiId)) throw new ParticipationValidationError(`emojiId 非法：${JSON.stringify(reaction.emojiId ?? null)}`)
    out.reaction = { messageId, emojiId }
  }
  return out
}

const RANK = { full: 3, text_lite: 2, react: 1 }
const forcedFull = () => ({ level: 'full', sourceModuleId: '' })
const rankOf = (p) => (p && RANK[p.level]) || 0

/**
 * 按级别白名单收敛一份声明：非法对象（缺字段 / 未知 level）退回缺省 FULL；
 * 只保留该 level 允许的字段 —— full 不得带 limits／reaction，text_lite 不得带 reaction，
 * react 不得带 limits。单侧为空与双路合并都必须经过这里，绝不原样直拷贝未校验输入。
 */
const sanitize = (p) => {
  if (!p || !rankOf(p)) return forcedFull()
  const out = { level: p.level, sourceModuleId: String(p.sourceModuleId || '') }
  if (p.level === 'text_lite' && p.limits && typeof p.limits === 'object' && !Array.isArray(p.limits)) {
    const limits = {}
    if (Number.isInteger(p.limits.maxBubbles)) limits.maxBubbles = p.limits.maxBubbles
    if (Number.isInteger(p.limits.maxChars)) limits.maxChars = p.limits.maxChars
    if (Object.keys(limits).length) out.limits = limits
  }
  if (p.level === 'react' && p.reaction && typeof p.reaction === 'object' && !Array.isArray(p.reaction)) {
    out.reaction = { messageId: String(p.reaction.messageId ?? ''), emojiId: String(p.reaction.emojiId ?? '') }
  }
  return out
}

/**
 * 同一回合按入站顺序逐次合并两份参与声明（调用方保证 previous 在先、next 更新）。
 * @param {object|null} previous 该回合此前的合并结果（首次记账传 null）
 * @param {object|null} next 本次新入站成员的声明
 * @param {string|null} previousMode previous 记账时的回合模式（must / engaged / interject）
 * @param {string|null} nextMode 本次入站成员的回合模式
 */
export function mergeParticipation(previous, next, previousMode, nextMode) {
  // 任一成员模式升级为 must／engaged：整回合 FULL，清除 limits / reaction / sourceModuleId（永不降级）
  if ((previousMode && previousMode !== 'interject') || (nextMode && nextMode !== 'interject')) return forcedFull()
  if (!previous && !next) return forcedFull()
  // 单侧为空同样必须走白名单收敛：不许绕过 rankOf 防御与字段裁剪直拷贝
  if (!previous) return sanitize(next)
  if (!next) return sanitize(previous)
  const prev = sanitize(previous)
  const nxt = sanitize(next)
  const pr = rankOf(prev)
  const nr = rankOf(nxt)
  const max = Math.max(pr, nr)
  if (max >= 3) {
    // 任一成员 FULL：整回合 FULL，无 reaction / limits 残留；归因唯一才留 sourceModuleId
    const src = pr >= 3 && nr >= 3
      ? (prev.sourceModuleId === nxt.sourceModuleId ? nxt.sourceModuleId : '')
      : (nr >= 3 ? nxt.sourceModuleId : prev.sourceModuleId)
    return { level: 'full', sourceModuleId: String(src || '') }
  }
  if (max === 2) {
    // 无 FULL、至少一个 TEXT_LITE：整回合 TEXT_LITE；已定义的 maxBubbles / maxChars 分别取最小值；
    // TEXT_LITE 由多个不同模块共同贡献、无法唯一归因时 sourceModuleId 置空
    const tl = [prev, nxt].filter((p) => p.level === 'text_lite')
    const limits = {}
    const bubbles = tl.map((p) => p.limits?.maxBubbles).filter((v) => Number.isInteger(v))
    const chars = tl.map((p) => p.limits?.maxChars).filter((v) => Number.isInteger(v))
    if (bubbles.length) limits.maxBubbles = Math.min(...bubbles)
    if (chars.length) limits.maxChars = Math.min(...chars)
    const src = tl.length === 2 && tl[0].sourceModuleId !== tl[1].sourceModuleId ? '' : tl[0].sourceModuleId
    const out = { level: 'text_lite', sourceModuleId: String(src || '') }
    if (Object.keys(limits).length) out.limits = limits
    return out
  }
  // 只剩 REACT（多个 REACT）：只保留最新入站成员的锚点，sourceModuleId 与它一致，不连发多个
  //（nxt 已经过 sanitize 白名单收敛，是干净副本）
  return nxt
}
