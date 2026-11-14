// 四态话语权与收尾算法（计划书 v3.4 阶段 0b）。
//
// 以前「这段聊天该不该继续说」没有任何名字：插话靠关键词 + 掷骰子，
// 收尾靠对方不再回。真正要回答的其实只有两个问题：
//   · 现在还该继续展开吗（能多说几个气泡、能不能反问对方）
//   · 是不是该礼让收缩、甚至主动收尾（闭麦一段时间的主动搭话）
// 这里用四个状态回答：DOMINANT（继续展开）/ BALANCED（对等）/ YIELDING（礼让收缩）/
// CLOSED（收敛关闭）。
//
// 纯函数、零 I/O：update(state, signal) 返回下一轮的**完整**状态，
// 调用方只需要把上一轮的返回值传回来，不用自己维护计数器。
// 计数器（连续附和条数、回合数）随状态一起流动，所以同样输入永远得到同样输出。
//
// 与 docs/reference/surfcore-conversation-closure.md 里那套不是同一个东西：那份是桥接层的
// 三态建议（continue/linger/close，配 qq_close_conversation 工具与冷却），只管「这一轮还
// 补不补一句」；这里是纯算法层的四态话语权，多回答两个问题——这轮最多几个气泡、能不能反
// 问、主动搭话要闭麦多久。两者可以并存：本模块的 CLOSED 可以喂给桥接层的 close 决策。

export const DOMINANT = 'dominant'
export const BALANCED = 'balanced'
export const YIELDING = 'yielding'
export const CLOSED = 'closed'

/** CLOSED 的主动交互硬锁：一小时。只锁主动搭话，不锁入站回复。 */
export const MUTE_LOCK_MS = 60 * 60 * 1000

const ACK_YIELDING = 2 // 连续几条单字附和算「把话头交回去了」
const ACK_CLOSED = 4 // 一直只回「嗯」到这个数就收敛
const YIELD_MUTE_MS = 2 * 60_000 // 礼让收缩时给主动搭话的短锁
const SHORT_REPLY_MAX = 4 // 这么短的回话算「对方没劲了」
const TREND_RATIO = 1.3 // 长度涨/跌这么明显才算趋势
const REPLY_WINDOW = 4 // 只看最近几轮长度

// 每个状态对应的发言处方（气泡数 / 能不能反问 / 主动搭话硬锁）
const PLAN = Object.freeze({
  [DOMINANT]: Object.freeze({ maxBubbles: 3, allowQuestion: true, muteLockMs: 0 }),
  [BALANCED]: Object.freeze({ maxBubbles: 2, allowQuestion: true, muteLockMs: 0 }),
  [YIELDING]: Object.freeze({ maxBubbles: 1, allowQuestion: false, muteLockMs: YIELD_MUTE_MS }),
  [CLOSED]: Object.freeze({ maxBubbles: 1, allowQuestion: false, muteLockMs: MUTE_LOCK_MS }),
})

// 道别判定必须是**词级 + 句尾锚定**，不能是裸子串。
// 中文单字「见 / 晚 / 拜 / 下 / 走」到处都能命中：`text.includes('明天见')` 会把
// 「好的，明天见吧」（提议，不是告别）、`includes('下了')` 会把「下了一整天雨」、
// `includes('88')` 会把「花了 188」全判成道别；一判 CLOSED 就是静音一小时，
// 误伤的代价远高于漏判。所以这里只认三件事：
//   1. 按标点切成小句，只看**最后一个小句**——道别永远在句尾说；
//   2. 最后一个小句去掉句尾语气词后，必须以常见道别词**结尾**（含 88 的必须独立成词）；
//   3. 需要动词的道别（睡了 / 走了 / 下了）必须带「我先 / 那我先 / 该 / 得」这类
//      主语或情态前缀，且动词后不能再跟别的内容——「他早就走了」不算，「我先走了」才算。
// 「吧」默认不当语气词剥掉（「明天见吧」是提议），只有「先这样吧 / 就这样吧」这类
// 已成固定告别的说法单独列出。
const CLAUSE_SPLIT_RE = /[\s,，、.。;；:：!！?？~～…·|/\\()（）\[\]【】「」『』“”"'‘’]+/u
const TAIL_PARTICLES_RE = /[了啦咯喽啰哟呀哇哈哒哦噢]+$/u

// 强道别词：小句以它结尾即算道别
const FAREWELL_SUFFIX_RE = new RegExp(
  '(?:' +
    [
      '拜拜', '白白', '掰掰', '晚安',
      '再见', '再会', '回头见', '改天见', '下次见', '明天见', '明儿见', '晚点见', '待会见',
      '回聊', '回头聊', '回头再聊', '下次聊', '下次再聊', '改天聊', '改天再聊', '有空聊',
      '明天聊', '先这样吧', '就这样吧', '先这样', '就这样',
      '不聊了', '先不聊了', '不说了', '先不说了', '去忙了', '先忙了', '我忙去了',
      'bye', 'byebye',
      '(?<!\\d)88(?:6)?', // 「88」必须独立成词，不能从「188」里切出来
    ].join('|') +
  ')$',
  'iu'
)

// 动词类道别：前缀不可省（防止「他早就走了」「我早早就睡了」这类叙述误判）
const LEAVE_SUFFIX_RE = new RegExp(
  '(?:' +
    ['那我先', '那我', '我先', '我们', '咱们', '我这就', '我', '先', '得', '该', '要'].join('|') +
  ')(?:去)?(?:' +
    ['睡(?:觉)?', '走', '撤', '下(?:线)?', '挂', '洗澡', '吃饭去', '出门', '上班去'].join('|') +
  ')$',
  'u'
)

// 整句就是一个光秃秃的道别动词（单条消息只发「走了」「睡了」）
const FAREWELL_EXACT = new Set(['走', '撤', '挂', '下', '下线', '睡', '睡觉', '睡去', '睡觉去', '去睡了', '出门'])

const QUESTION_RE = /[?？]|(?:吗|呢|么|嘛)\s*$/
const ACK_RE = /^(?:嗯+|哦+|喔+|噢+|啊+|哈+|对+|是+|好+|行+|ok+|👌)[\s。.!！~]*$/i

/**
 * 从原始文本里认出三类信号（调用方已有结构化标记时可以不用它）。
 * @param {unknown} text
 * @returns {{ isQuestion: boolean, isAck: boolean, isFarewell: boolean, length: number }}
 */
export function detectSignal(text) {
  const raw = String(text ?? '').trim()
  const compact = raw.replace(/\s+/gu, '')
  return {
    isFarewell: isFarewellText(compact),
    isQuestion: QUESTION_RE.test(raw),
    // 单字附和：去掉空白和句末标点后只剩「嗯/哦/好/行/ok」这类零信息回话
    isAck: compact.length > 0 && ACK_RE.test(compact),
    length: Array.from(raw).length,
  }
}

/**
 * 这条消息是不是真道别（词级 + 句尾锚定，见文件头部 FAREWELL_* 的说明）。
 * 只看最后一个小句：前面几小句是铺垫（「今天聊得挺开心，我先睡了」），
 * 道别语一定落在句尾。
 * @param {string} full 已压缩掉空白的整条文本
 * @returns {boolean}
 */
function isFarewellText(full) {
  const text = String(full ?? '').trim()
  if (!text) return false
  const clauses = text.split(CLAUSE_SPLIT_RE).filter(Boolean)
  if (!clauses.length) return false
  const tailClause = clauses[clauses.length - 1]
  // 剥掉句尾语气词（「晚安啦」「拜拜咯」），「吧」不在此列：它是提议语气
  const core = tailClause.replace(TAIL_PARTICLES_RE, '') || tailClause
  if (FAREWELL_EXACT.has(core)) return true
  if (FAREWELL_SUFFIX_RE.test(core)) return true
  return LEAVE_SUFFIX_RE.test(core)
}

/**
 * 长度趋势：只看最近两轮，涨跌要超过 TREND_RATIO 才算数。
 * @param {number[]} lengths 对方回话长度，最新在末尾
 * @returns {'up'|'flat'|'down'}
 */
export function lengthTrend(lengths) {
  if (lengths.length < 2) return 'flat'
  const last = lengths[lengths.length - 1]
  const prev = lengths[lengths.length - 2]
  if (prev === 0 && last === 0) return 'flat'
  if (prev === 0) return last > 0 ? 'up' : 'flat'
  if (last >= prev * TREND_RATIO) return 'up'
  if (last * TREND_RATIO <= prev) return 'down'
  return 'flat'
}

/**
 * 推进一轮话语权状态。
 * @param {object|null|undefined} state 上一轮的返回值（首轮传 null）
 * @param {object} signal 本轮信号
 * @param {number[]} [signal.lengths] 对方最近几轮回话长度（最新在末尾）
 * @param {'up'|'flat'|'down'} [signal.trend] 直接给趋势（给了就忽略 lengths）
 * @param {boolean} [signal.isQuestion] 对方这条是不是问句
 * @param {boolean} [signal.isAck] 对方这条是不是单字附和
 * @param {boolean} [signal.isFarewell] 对方这条是不是道别
 * @param {string} [signal.text] 原始文本，缺省标记由 detectSignal 补
 * @returns {{ state: string, maxBubbles: number, allowQuestion: boolean, muteLockMs: number,
 *   ackStreak: number, trend: string, turns: number, reason: string }}
 * @throws {TypeError} 参数形状不对（fail-closed，不静默兜底）
 */
export function updateClosureState(state, signal) {
  const prev = readState(state)
  const sig = readSignal(signal)

  const ackStreak = sig.isAck ? prev.ackStreak + 1 : 0
  const trend = sig.trend || lengthTrend(sig.lengths)
  const lastLen = sig.lengths.length ? sig.lengths[sig.lengths.length - 1] : sig.text.trim().length
  const blank = sig.lengths.length === 0 && !sig.text.trim() && !sig.isQuestion && !sig.isAck && !sig.isFarewell && !sig.trend
  const turns = prev.turns + (blank ? 0 : 1)

  let next
  let reason
  if (sig.isFarewell) {
    next = CLOSED // 对方已经道别：这一轮就是收尾，别再追问
    reason = 'farewell'
  } else if (ackStreak >= ACK_CLOSED) {
    next = CLOSED // 连着几条只有「嗯」，再说就是自言自语
    reason = 'ack-streak-closed'
  } else if (ackStreak >= ACK_YIELDING) {
    next = YIELDING // 对方把话头丢回来了：少说，等对方开口
    reason = 'ack-streak'
  } else if (prev.state === CLOSED) {
    // 已关闭后：只有实质内容（不是又一句「嗯」）才重新打开这个话头
    next = sig.isAck || !lastLen ? CLOSED : BALANCED
    reason = next === CLOSED ? 'closed-sticky' : 'reopened'
  } else if (sig.isQuestion || trend === 'up') {
    next = DOMINANT // 对方在展开／反问：可以多说，也可以接话反问
    reason = sig.isQuestion ? 'question' : 'length-up'
  } else if (trend === 'down' || (lastLen > 0 && lastLen <= SHORT_REPLY_MAX)) {
    next = YIELDING // 对方回得越来越短：礼让收缩，不再追着讲
    reason = trend === 'down' ? 'length-down' : 'short-reply'
  } else {
    next = BALANCED
    reason = 'steady'
  }

  const plan = PLAN[next]
  return { state: next, maxBubbles: plan.maxBubbles, allowQuestion: plan.allowQuestion, muteLockMs: plan.muteLockMs, ackStreak, trend, turns, reason }
}

/** 上一轮状态 → 内部计数器（首轮给默认值）。 */
function readState(state) {
  if (state === null || state === undefined) return { state: BALANCED, ackStreak: 0, turns: 0 }
  if (typeof state !== 'object' || Array.isArray(state)) throw new TypeError('conversation-closure: state 必须是对象或 null')
  if (!Object.hasOwn(PLAN, state.state)) throw new TypeError(`conversation-closure: 未知状态 ${String(state.state)}`)
  return {
    state: state.state,
    ackStreak: readCount(state.ackStreak, 'state.ackStreak'),
    turns: readCount(state.turns, 'state.turns'),
  }
}

/** 本轮信号规范化；类型不对一律 TypeError，不做「猜一个」。 */
function readSignal(signal) {
  if (typeof signal !== 'object' || signal === null || Array.isArray(signal)) throw new TypeError('conversation-closure: signal 必须是对象')
  const lengths = signal.lengths === undefined ? [] : signal.lengths
  if (!Array.isArray(lengths)) throw new TypeError('conversation-closure: signal.lengths 必须是数字数组')
  const tail = lengths.slice(-REPLY_WINDOW).map((n, i) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new TypeError(`conversation-closure: signal.lengths[${i}] 必须是非负有限数字`)
    return n
  })
  if (signal.trend !== undefined && !['up', 'flat', 'down'].includes(signal.trend)) throw new TypeError(`conversation-closure: signal.trend 只能是 up/flat/down，收到 ${String(signal.trend)}`)
  if (signal.text !== undefined && typeof signal.text !== 'string') throw new TypeError('conversation-closure: signal.text 必须是字符串')

  const text = signal.text ?? ''
  const guess = text ? detectSignal(text) : { isQuestion: false, isAck: false, isFarewell: false }
  return {
    lengths: tail,
    trend: signal.trend,
    text,
    isQuestion: readFlag(signal.isQuestion, guess.isQuestion, 'signal.isQuestion'),
    isAck: readFlag(signal.isAck, guess.isAck, 'signal.isAck'),
    isFarewell: readFlag(signal.isFarewell, guess.isFarewell, 'signal.isFarewell'),
  }
}

function readFlag(value, fallback, label) {
  if (value === undefined) return Boolean(fallback)
  if (typeof value !== 'boolean') throw new TypeError(`conversation-closure: ${label} 必须是布尔值`)
  return value
}

function readCount(value, label) {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`conversation-closure: ${label} 必须是非负整数`)
  return value
}

// 兼容旧命名：带前缀名，避免裸名 update 跨模块撞车。
export const closureUpdate = updateClosureState
