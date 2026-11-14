// S1 线索生产者：从**一轮真实对话**里捞出「说了但没了结」的线索（纯函数，零 I/O 零网络）。
//
// 为什么需要这一层：`thread-ledger.js` 只提供 push() 契约，`inner-thread-link.js` 只负责
// 闭环/推进；两者中间缺的是**入口**——生产上没有任何代码往账本里写，于是账本永远为空，
// 【顺承前情】、dormant 归档、线索 Provider 全链路空转（US-019）。
//
// 设计边界：
//  - 纯函数：不读配置、不读时钟（now 只是接住调用方的统一时间戳口径，不参与判定）、
//    不 import 任何 I/O 模块，账本校验/落盘/归档一概不在本模块；
//  - 只产出 `{ chatKey, type, summary, ttlMs }` 四字段，形状与 `ledger.push()` 的入参一致；
//  - 同 chatKey + type + 归一化 summary **只产出一条**（账本自身还会合并 active 重复项，
//    但生产者也别把同一句话吐两遍——那会让 recurrence 莫名其妙地涨）；
//  - 无命中返回 `[]`：宁可漏一条线索（下一轮 S2 慢思考还能补），也绝不错挂一条噪音线索。
//
// 三个文本来源，各管一段：
//   1. userText   —— 用户自己说的（去洗澡、明天给你、回头再说）；
//   2. innerMeta.memo —— 模型在 <inner> 里【备忘】记下的（她比规则更容易注意到「这事没完」）；
//   3. replyText  —— 她这轮发出去的正文（用来判断 queston_pending：她问了、对方还没答）。
// 同一条分句只归属一个类型（优先级 temporary_leave > promise > topic_postponed），
// 避免「我先去吃饭了 回头再说」被拆成两条互不相干的线索。

import { THREAD_TYPES } from './thread-ledger.js'

/** 摘要硬上限（Code point）：进提示词只占一行，60 字足够说清一件事。 */
export const MAX_PRODUCER_SUMMARY_CHARS = 60

/**
 * 分类型的默认软 TTL。
 *
 * 口径（计划书 §5.2 只给了 temporary_leave 的 2 小时，其余按「多久之内还算同一段对话」定）：
 *   - temporary_leave 2 小时：洗澡/吃饭/上班，「一会儿回来」的语义尺度；
 *   - promise 24 小时：跨天约定（明天给你、回头发你）必须活过一整夜；
 *   - question_pending 6 小时：她问出去的问题，隔了半天没答基本已经翻篇；
 *   - topic_postponed 4 小时：说到一半被打断，通常当天就会接回来。
 */
export const TYPE_TTL_MS = Object.freeze({
  temporary_leave: 2 * 3600_000,
  promise: 24 * 3600_000,
  question_pending: 6 * 3600_000,
  topic_postponed: 4 * 3600_000,
})

// 分句：句读、空格统一当一个分隔（中文里空格多数是随手打的停顿）。
const CLAUSE_RE = /[^。！？!?；;，,、\n\r\t ]+/gu
// 句子（保留句末问号）：question_pending 判定要看句尾。
const SENTENCE_RE = /[^。！？!?\n]+[。！？!?]?/gu

/**
 * 离开类：去洗澡 / 先吃饭 / 去睡了 / 上班 / 出门 / 一会儿回来。
 * 刻意写「去+具体动作」而不是光认「去」，否则「我去看看」会被误判成离开。
 */
const LEAVE_PATTERNS = [
  /(?:我)?(?:先|马上|这就|得|要)?(?:去|回)(?:洗个?澡|洗澡|冲个?澡|吃饭|睡|睡觉|上班|出门|忙|上厕所|开会|接电话|下楼|买菜|做饭|跑步|健身)/u,
  /(?:一会儿|等会儿|待会儿|等下|马上|晚点|过会儿)(?:就)?回来/u,
  /(?:我)?(?:先|得|要)忙(?:一下|一会儿|会儿)/u,
  /(?:我)?(?:先)?睡了/u,
]

/**
 * 约定类：答应/保证/明天给你/回头发你/晚点分享。
 * 时间词后面必须跟一个「交付动作」，否则「明天」「晚点」自己不成线索。
 */
const PROMISE_PATTERNS = [
  /(?:答应|保证|承诺|说好|讲好)(?:你|过|了)?/u,
  // 时间词与交付动作之间允许夹几个字（「明天把链接发你」里的「把链接」），但不跨句读。
  /(?:明天|后天|周末|今晚|下午|晚上|下次|回头|晚点|待会|一会儿|过两天)[^，,。；;]{0,8}(?:发|给|带|分享|告诉|传|送|拿|整理|弄|做|写)/u,
  /(?:发|给|带|分享|告诉|传|送)(?:你|给你|给你看)(?:哈|啊|哦)?(?:$|[，,。！!])/u,
]

/**
 * 中断类：话说到一半被打断 / 先不说了 / 回头再说。
 * 只认明确的中断信号，不把「先这样吧」之外的模糊收尾也算进来。
 */
const POSTPONE_PATTERNS = [
  /(?:说到一半|话说一半|话没说完|没说完|没讲完|被打断|打断了)/u,
  /(?:先不说了|先不聊了|先说到这|先这样吧?|回头再说|晚点再说|等下再说|等会儿接着说|待会儿接着说|一会儿接着说)/u,
]

/** 问句线索：句末问号 + 一个疑问词（光有问号可能是反问/自问，不足以当线索）。 */
const QUESTION_CUE = /(?:吗|呢|么|怎么|几点|哪儿|哪里|什么|为什么|有没有|是不是|要不要|能不能|好不好|对不对|哪个|多少|多久|干啥|干嘛|行不行|可不可以)/u

/**
 * 四类线索的识别规则（顺序即优先级：靠前的类型先认领分句）。
 * `source` 只是给读代码的人看的：user / memo 走这三条，reply 只走 question_pending。
 */
const TEXT_RULES = [
  { type: 'temporary_leave', patterns: LEAVE_PATTERNS, source: 'user|memo' },
  { type: 'promise', patterns: PROMISE_PATTERNS, source: 'user|memo' },
  { type: 'topic_postponed', patterns: POSTPONE_PATTERNS, source: 'user|memo' },
]

/**
 * 摘要归一化：去标点、去空白、截断到 max 个 Code point。
 * 这是「同一条线索」的**判重口径**，也是进提示词的正文——所以绝不为空（空则返回 ''，调用方丢弃）。
 * 按 Array.from 切，emoji 尾巴不会被截成孤立代理对。
 */
export function normalizeThreadSummaryText(value, max = MAX_PRODUCER_SUMMARY_CHARS) {
  const text = String(value ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
  if (!text) return ''
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** 把一段文本按句读/空格切成 [{start, text}]（start 用于「这个分句已被前一个类型认领」的去重）。 */
function splitClauses(text) {
  const out = []
  const re = new RegExp(CLAUSE_RE.source, CLAUSE_RE.flags)
  let match = re.exec(text)
  while (match !== null) {
    out.push({ start: match.index, text: match[0] })
    match = re.exec(text)
  }
  return out
}

/** 分句太长（用户一口气打一大段）时，只留命中词周围的一小截，别把整段塞成摘要。 */
function clipAround(clause, index, length, max = 40) {
  if (clause.length <= max) return clause
  const from = Math.max(0, index - 6)
  const to = Math.min(clause.length, index + length + 14)
  return clause.slice(from, to)
}

/** 问句取尾部（疑问语气在句尾，长句从头截会把问句本身切掉）。 */
function clipQuestion(sentence, max = 40) {
  const points = Array.from(String(sentence || ''))
  return points.length <= max ? points.join('') : points.slice(-max).join('')
}

/**
 * 从一轮对话里挖线索。
 *
 * @param {object} input
 * @param {string} input.chatKey 会话键（`private:<数字ID>` / `group:<数字ID>`），空/非法直接返回 []
 * @param {string} [input.userText] 用户这一轮说的话
 * @param {{memo?:string, raw?:string, intent?:string}} [input.innerMeta]
 *   `extractAndStripInnerMonologue()` 解析出的 `<inner>` 元数据；只读 `memo`（【备忘】）
 * @param {string} [input.replyText] 她这一轮发出去的正文（已剥掉 `<inner>`）
 * @param {number} [input.now] 调用方统一时钟（本模块纯函数，不参与判定，只为签名对齐）
 * @returns {Array<{chatKey:string, type:string, summary:string, ttlMs:number}>}
 */
export function mineThreads({ chatKey, userText, innerMeta, replyText, now } = {}) {
  const key = typeof chatKey === 'string' ? chatKey.trim() : ''
  if (!key) return []
  void now // 纯函数：不读时钟；保留参数是为了让调用方的「同一轮同一个 now」口径一致

  const out = []
  const seen = new Set()
  const add = (type, rawSummary) => {
    if (!THREAD_TYPES.includes(type)) return
    const summary = normalizeThreadSummaryText(rawSummary)
    if (!summary) return
    const dedupe = `${type}|${summary}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    out.push({ chatKey: key, type, summary, ttlMs: TYPE_TTL_MS[type] })
  }

  mineClauses(String(userText ?? ''), add)
  const inner = innerMeta && typeof innerMeta === 'object' ? innerMeta : {}
  mineClauses(String(inner.memo ?? ''), add)
  mineQuestions(String(replyText ?? ''), add)
  return out
}

/** 按规则优先级扫分句：一个分句只归属第一个认出它的类型。 */
function mineClauses(text, add) {
  if (!text) return
  const clauses = splitClauses(text)
  if (!clauses.length) return
  const claimed = new Set()
  for (const rule of TEXT_RULES) {
    for (const clause of clauses) {
      if (claimed.has(clause.start)) continue
      for (const pattern of rule.patterns) {
        const match = pattern.exec(clause.text)
        if (!match) continue
        claimed.add(clause.start)
        add(rule.type, clipAround(clause.text, match.index, match[0].length))
        break
      }
    }
  }
}

/** 她这轮问出去、对方还没答的问题（句末问号 + 疑问词）。 */
function mineQuestions(text, add) {
  if (!text) return
  const re = new RegExp(SENTENCE_RE.source, SENTENCE_RE.flags)
  let match = re.exec(text)
  while (match !== null) {
    const sentence = match[0].trim()
    if (/[？?]\s*$/u.test(sentence) && QUESTION_CUE.test(sentence)) {
      add('question_pending', clipQuestion(sentence))
    }
    match = re.exec(text)
  }
}