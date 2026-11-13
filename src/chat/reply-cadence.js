// 仿真打字律动：多气泡回复的「思考时延 + 逐字击键 + 呼吸间隙」计算。
// 纯函数、零 I/O：随机源由调用方注入（默认 Math.random），测试可换成固定序列。
// 所有时延参数集中在本文件的常量里，再由回复配置的 reply.cadence.enabled 统一开关。

/** 时延参数（ms）。数组表示随机区间 [下限, 上限]，按注入的随机源取中点插值。 */
export const TYPING_CADENCE = Object.freeze({
  // 第一条气泡要先读题、组织语言；后面几条只需要顺着话头往下说。
  // 后续段刻意压得比首段短：短句连发的等待上界要留在 1 秒内，才像随手连打
  thinkMs: Object.freeze({ first: Object.freeze([380, 900]), next: Object.freeze([100, 300]) }),
  // 每个字符的击键时间（真人中文手机输入大约每秒 9~14 字，含零星回删的抖动）
  keystrokeMs: Object.freeze([45, 100]),
  // 标点处的额外停顿：逗号顿号短顿，句号问号感叹号长顿
  punctuationPauseMs: Object.freeze({ short: Object.freeze([70, 150]), long: Object.freeze([150, 280]) }),
  // 气泡之间的呼吸间隙（发完一段、想清下一句再打）
  bubbleGapMs: Object.freeze([120, 300]),
  // 非文字条目（表情、戳一戳、图片）抬手就发，只给一点点击延迟
  nonTextPickupMs: Object.freeze([80, 180]),
  // 超长段封顶：只按前 N 个字计击键时间，避免「几千字方块」算出几分钟的等待
  maxCharsPerBubble: 120,
  // 单段总时延上下限（含思考）
  maxBubbleMs: 6000,
  minBubbleMs: 380,
})

const SHORT_PUNCTUATION = new Set([',', '\uFF0C', '\u3001', ';', '\uFF1B', ':', '\uFF1A'])
const LONG_PUNCTUATION = new Set(['.', '\u3002', '?', '\uFF1F', '!', '\uFF01', '\u2026', '~', '\uFF5E', '\n'])

function isShortPunctuation(ch) {
  if (SHORT_PUNCTUATION.has(ch)) return true
  return ch.length > 1 && Array.from(ch).some((cp) => SHORT_PUNCTUATION.has(cp))
}

function isLongPunctuation(ch) {
  if (LONG_PUNCTUATION.has(ch)) return true
  return ch.length > 1 && Array.from(ch).some((cp) => LONG_PUNCTUATION.has(cp))
}

function numberIn(range, rand, fallback) {
  const [lo, hi] = Array.isArray(range) ? range : []
  const a = Number.isFinite(lo) ? lo : fallback
  const b = Number.isFinite(hi) ? hi : a
  const low = Math.min(a, b)
  const high = Math.max(a, b)
  const raw = typeof rand === 'function' ? rand() : 0.5
  const t = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5
  return low + (high - low) * t
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** 条目正文：字符串条目、{kind,value} 条目都按文字处理，其余视为非文字。 */
function textOf(part) {
  if (typeof part === 'string') return part
  if (part && typeof part === 'object' && typeof part.value === 'string') return part.kind === 'text' || part.kind === 'voice' ? part.value : ''
  return ''
}

function kindOf(part) {
  if (typeof part === 'string') return 'text'
  if (part && typeof part === 'object' && typeof part.kind === 'string') return part.kind
  return 'unknown'
}

// 字素簇切分器：ZWJ 家族 emoji（👨‍👩‍👧‍👦）、组合附标、国旗这类「一个字符 = 多次击键」的
// 码点序列要按一个字素算，否则 7 个 code point 会被当成 7 次击键，明显高估。
// Intl.Segmenter 不可用的运行时（老 Node / 裁剪过的 ICU）退回 code point 计数。
const graphemeSegmenter = (() => {
  try {
    return typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null
  } catch {
    return null
  }
})()

/** 按字素簇切分；切分器不可用或抛错时退回 code point（Array.from）。纯函数，不缓存、不 I/O。 */
function toGraphemes(text) {
  if (typeof text !== 'string' || text === '') return []
  if (graphemeSegmenter) {
    try {
      const out = []
      for (const piece of graphemeSegmenter.segment(text)) out.push(piece.segment)
      if (out.length > 0) return out
    } catch {
      // 落到下面的 code point 兜底
    }
  }
  return Array.from(text)
}

function typingMsOf(chars, rand, defaults) {
  let total = 0
  for (const ch of chars) {
    total += numberIn(defaults.keystrokeMs, rand, 55)
    // 多码点的字素簇（emoji 家族、组合附标）按整簇里出现过的标点算停顿，绝不重复计入
    if (isShortPunctuation(ch)) total += numberIn(defaults.punctuationPauseMs.short, rand, 90)
    else if (isLongPunctuation(ch)) total += numberIn(defaults.punctuationPauseMs.long, rand, 180)
  }
  return total
}

/** 合并外部常量与默认值：任何缺项/非法值都退回默认常量，避免半配置崩掉。 */
function resolveLimits(constants) {
  const src = constants && typeof constants === 'object' ? constants : {}
  const pair = (value, fallback) => (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : fallback)
  const think = src.thinkMs && typeof src.thinkMs === 'object' ? src.thinkMs : {}
  const pause = src.punctuationPauseMs && typeof src.punctuationPauseMs === 'object' ? src.punctuationPauseMs : {}
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    thinkMs: { first: pair(think.first, TYPING_CADENCE.thinkMs.first), next: pair(think.next, TYPING_CADENCE.thinkMs.next) },
    keystrokeMs: pair(src.keystrokeMs, TYPING_CADENCE.keystrokeMs),
    punctuationPauseMs: { short: pair(pause.short, TYPING_CADENCE.punctuationPauseMs.short), long: pair(pause.long, TYPING_CADENCE.punctuationPauseMs.long) },
    bubbleGapMs: pair(src.bubbleGapMs, TYPING_CADENCE.bubbleGapMs),
    nonTextPickupMs: pair(src.nonTextPickupMs, TYPING_CADENCE.nonTextPickupMs),
    maxCharsPerBubble: Math.floor(positive(src.maxCharsPerBubble, TYPING_CADENCE.maxCharsPerBubble)),
    maxBubbleMs: positive(src.maxBubbleMs, TYPING_CADENCE.maxBubbleMs),
    minBubbleMs: Number.isFinite(src.minBubbleMs) && src.minBubbleMs >= 0 ? src.minBubbleMs : TYPING_CADENCE.minBubbleMs,
  }
}

/**
 * 计算一轮多气泡回复的打字律动。
 * @param {Array<string|{kind?:string,value?:string}>} parts 按发送顺序排列的气泡
 * @param {{enabled?:boolean, random?:()=>number, constants?:object}} [options]
 * @returns {{valid:boolean, enabled:boolean, totalMs:number, bubbles:Array<object>}}
 */
export function calculateTypingCadence(parts, options = {}) {
  const {
    enabled = true,
    random = Math.random,
    constants = TYPING_CADENCE,
  } = options && typeof options === 'object' ? options : {}
  const limits = resolveLimits(constants)
  // 非法输入 fail-closed：直接不加时延，退化成「立刻发」
  if (!Array.isArray(parts) || parts.length === 0) return { valid: false, enabled: false, totalMs: 0, bubbles: [] }
  const rand = typeof random === 'function' ? random : () => 0.5
  const capChars = limits.maxCharsPerBubble
  const maxBubbleMs = limits.maxBubbleMs
  const minBubbleMs = Math.min(limits.minBubbleMs, maxBubbleMs)
  const bubbles = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const kind = kindOf(part)
    const text = textOf(part)
    const chars = toGraphemes(text).slice(0, capChars)
    if (enabled === false) {
      bubbles.push({ index: i, kind, chars: 0, thinkMs: 0, typingMs: 0, gapAfterMs: 0, totalMs: 0 })
      continue
    }
    const thinkMs = chars.length > 0 || kind === 'text'
      ? numberIn(i === 0 ? limits.thinkMs.first : limits.thinkMs.next, rand, i === 0 ? TYPING_CADENCE.thinkMs.first[0] : TYPING_CADENCE.thinkMs.next[0])
      : 0
    const typingMs = chars.length > 0 ? typingMsOf(chars, rand, limits) : numberIn(limits.nonTextPickupMs, rand, 90)
    const totalMs = clamp(thinkMs + typingMs, minBubbleMs, maxBubbleMs)
    bubbles.push({ index: i, kind, chars: chars.length, thinkMs: Math.round(thinkMs), typingMs: Math.round(typingMs), gapAfterMs: 0, totalMs: Math.round(totalMs) })
  }
  if (enabled !== false) {
    for (let i = 0; i < bubbles.length - 1; i++) bubbles[i].gapAfterMs = Math.round(numberIn(limits.bubbleGapMs, rand, 220))
  }
  const totalMs = bubbles.reduce((sum, bubble) => sum + bubble.totalMs + bubble.gapAfterMs, 0)
  return { valid: true, enabled: enabled !== false, totalMs, bubbles }
}

/** 发完第 index 条之后、发下一条之前要等多久：呼吸间隙 + 下一条的思考与击键。 */
export function typingWaitAfter(cadence, index) {
  const bubbles = cadence?.bubbles
  if (!Array.isArray(bubbles) || !Number.isInteger(index) || index < 0 || index >= bubbles.length - 1) return 0
  const next = bubbles[index + 1]
  // 用封顶后的 totalMs：超长段不该把等待时间拖成几分钟
  return Math.max(0, Math.round((bubbles[index].gapAfterMs || 0) + (next?.totalMs || 0)))
}

/** 配置开关：reply.cadence.enabled 显式关掉就退回既有固定公式。 */
export function typingCadenceEnabled(cfg) {
  return cfg?.reply?.cadence?.enabled !== false
}
