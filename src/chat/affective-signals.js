// US-015 · 关系信号挖掘（affective-signals）
//
// 情感图谱（`affective-graph.js`）只认 `SIGNAL_WEIGHTS` 里六种**可解释信号**，但"信号从哪来"
// 一直是空的：图永远 size=0、等级永远停在陌生人。这一层负责把一轮真实对话读成那六种信号。
//
// 设计红线（与图谱同一口径）：
//   1. **纯函数、零 I/O**：不读配置、不读文件、不写日志、不 import 宿主；同样的输入必产出同样的结果
//      （正则/规则驱动，无随机数、无 Date.now 兜底——`now` 由调用方给，不给就不做"深夜"判定）；
//   2. **宁可漏判不可误判**：每条信号都有 confidence 下限（`MIN_CONFIDENCE`），低于下限直接不产出；
//      负面信号（conflict / boundary-violation）门槛更高，并且要求**明确的敌意/拒绝证据**，
//      模糊语境一律不产出——误判一次 -2/-3 分要很久才能补回来；
//   3. **可解释**：每条信号带 `note`，引用触发它的原话片段（截断且压缩空白），面板可追溯"为什么涨/掉"；
//   4. 无命中返回 `[]`（不是 undefined），调用方可以直接 `.length` 判断。
//
// 输出形状固定为 `{ kind, note, confidence }`，kind 一定在 `SIGNAL_KINDS` 内、单个 kind 每轮最多一条
// （取置信度最高者），保证同一轮不会因为"复读机式刷屏"重复计分（跨轮的冷却在模块层做）。

import { isChatKey } from './chat-key.js'

/** 六种信号（顺序即输出顺序，保证确定性）。与 `SIGNAL_WEIGHTS` 的键一一对应。 */
export const SIGNAL_KINDS = Object.freeze([
  'shared-joke',
  'deep-talk',
  'mutual-help',
  'conflict',
  'boundary-violation',
  'explicit-confirmed',
])

/**
 * 各信号的置信度下限：低于它一律不产出（"宁可漏判不可误判"的落地口径）。
 * 负面信号门槛明显更高：conflict 0.75 / boundary-violation 0.8。
 */
export const MIN_CONFIDENCE = Object.freeze({
  'shared-joke': 0.6,
  'deep-talk': 0.6,
  'mutual-help': 0.65,
  'conflict': 0.75,
  'boundary-violation': 0.8,
  'explicit-confirmed': 0.7,
})

/** note 里的原话片段上限（code point）：够追溯，不把小作文塞进快照与面板。 */
export const MAX_NOTE_CHARS = 120

// ---------------------------------------------------------------------------
// 词表（全部是"证据"，不是"猜测"）
// ---------------------------------------------------------------------------

/** 笑：双方都笑才算一起笑（单方笑可能是礼貌/自嘲）。 */
const LAUGH = /(哈{2,}|嘿{2,}|嘻{2,}|2333+|hhh+|笑死|绷不住|太好笑|好搞笑|太好笑|搞笑|逗死|笑到)/

/** 梗的元话语（复读/接梗/整活）：需要配合笑或引号，单靠它不算。 */
const JOKE_META = /(接梗|玩梗|这个梗|老梗|复读|整活|段子|梗词)/

/** 玩笑标记：出现这些词时，冲突词一律当作打闹（负面信号抑制用）。 */
const JOKE_SOFTENER = /(开玩笑|逗你玩|闹着玩|不是认真的|哈哈|嘿嘿|笑死|别当真)/

/**
 * 掏心窝 / 情绪自陈（deep-talk 的**强**证据词）：说的是自己的内心状态，
 * 不是日常碎事——单独出现就足以算「聊到心里去了」，不依赖长度。
 */
const DEEP_EMOTION = /(焦虑|抑郁|难受|撑不住|崩溃|委屈|孤独|想哭|哭过|失眠|睡不着|心事|失恋|分手|没安全感|害怕失去|原生家庭|撑不下去|情绪低落|emo了)/

/**
 * deep-talk 的**弱**证据词：日常话题里也会出现（"我妈让我早点睡""压力大"），
 * 必须有长度或跨轮上下文才认，且置信度更低。
 */
const DEEP_WEAK = /(压力(?:好|很|太|特别)?大|我爸妈|我爸|我妈|梦想|未来怎么办|害怕|好累)/

/** 强自陈：本身就是"只有亲近的人才说"的话，不依赖长度。 */
const DEEP_STRONG = /(我只跟你说|没跟别人说过|从来没跟别人说|掏心窝子?|说实话我|其实我一直|说句心里话|这些话我没跟别人讲)/

/** 内心活动标记（配合长消息判 deep-talk，避免"长通知"被当谈心）。 */
const DEEP_FEELING = /(感觉|觉得|其实|心里|不知道怎么办|是不是很可笑)/

/** 求帮忙（发起侧）。 */
const HELP_ASK = /(帮我|帮个忙|怎么办|能不能帮|教教我|求助|给个主意|出个主意|你帮我想想)/

/** 给建议/解决问题（回应侧）：只认实质性的帮忙动作，不认"不客气"这类礼貌客套。 */
const HELP_GIVE = /(建议|你可以|你可以先|试试|先把|记得|方法|步骤|这样做|这样办|我去查|我帮你)/

/** 道谢。 */
const THANKS = /(谢谢|多谢|感谢|谢啦|帮大忙|多亏|帮到我了)/

/** 问题解决（道谢的实质证据）。 */
const SOLVED = /(解决了|弄好了|搞定了|成功了|可以了|装好了|修好了)/

/** 明确敌意（conflict 的强证据）。 */
const CONFLICT_STRONG = /(你有病|有病吧|神经病|傻[逼bB]|滚开|滚吧|闭嘴|你他妈|去死|废物|脑子有问题|恶心人)/

/** 对立/争吵（conflict 的弱证据）：至少两条同时出现才算，单条一律不产。 */
const CONFLICT_MILD = /(你错了|烦死了|吵死了|无语|别跟我说话|不想跟你说话|你根本不懂|凭什么|别说了|拉黑)/

/** 拒绝/划界（bot 侧；boundary-violation 的必要条件）。 */
const REFUSAL = /(不想聊|别这样|打住|不舒服|到此为止|我说了不|不要这样|别问了|这个不聊|换个话题)/

/** 被拒绝后继续推进（user 侧）。 */
const PUSH = /(凭什么|为什么不行|我就要|偏要|继续说|你管不着|管得着吗|必须(?:告诉|回答)我|不许拒绝)/

/** 越界要求（user 侧）：把"关系"当命令下。 */
const VIOLATION_DEMAND = /(必须(?:喜欢|爱)我|你说你爱我|只能回我|不许(?:拒绝|不回)|你只能听我的)/

/** 本人明确认可关系变近（explicit-confirmed）。`你真好` 后接 笑/骗/玩 是调侃，不是认可。 */
const CONFIRM = /(你真好(?!笑|骗|玩)|我信任你|信得过你|你是我(?:最)?好的?朋友|你是我朋友|把你当朋友|认你这个朋友|你是自己人|有你在真好|离不开你|你懂我|咱俩是朋友|我们是朋友)/

/** 正向信号集合（负面信号在场时一律压制，见 mineSignals 收尾）。 */
const POSITIVE_KINDS = new Set(['shared-joke', 'deep-talk', 'mutual-help', 'explicit-confirmed'])

/**
 * 归一化：只保留字符串内容并压缩空白（正则匹配与 note 摘录共用一口径）。
 * 非字符串一律当空串——不猜、不 String(对象) 造出 "[object Object]" 去误命中。
 */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 摘一段原话做 note：匹配点前后各取 `radius` 个字符，压缩空白，超长按 code point 截断加省略号。
 * 纯函数：同一 (text, match) 永远给同一段。
 */
function snippetAt(text, index, length, radius = 28) {
  if (!text || typeof index !== 'number' || index < 0) return ''
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + Math.max(0, length) + radius)
  const body = text.slice(start, end).trim()
  const points = Array.from(body)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  if (points.length > MAX_NOTE_CHARS) return head + points.slice(0, MAX_NOTE_CHARS).join('') + '…'
  return head + body + tail
}

/** 正则 match → 原话片段。 */
function snippet(text, match, radius = 28) {
  if (!match || typeof match.index !== 'number') return ''
  return snippetAt(text, match.index, match[0].length, radius)
}

/** 取第一条命中的正则 match（deterministic：从左到右）。 */
function firstMatch(re, text) {
  if (!re || !text) return null
  const m = re.exec(text)
  return m && m.index >= 0 ? m : null
}

/** 统计不同弱证据命中数（用于"至少两条才算"的保守规则）。 */
function countMild(text) {
  const seen = new Set()
  const global = new RegExp(CONFLICT_MILD.source, 'g')
  let m
  while ((m = global.exec(text)) !== null) {
    seen.add(m[0])
    if (seen.size >= 2) break
    if (global.lastIndex === m.index) global.lastIndex += 1 // 零宽兜底，防死循环
  }
  return seen.size
}

const has = (re, text) => Boolean(re && text && re.test(text))

/** 一句话里是否同时出现引号片段（复读/回顾梗的形态：`「...」` 或 `“...”`）。 */
function quotedFragment(text) {
  const m = /[「“"]([^」”"]{2,12})[」”"]/.exec(text)
  return m ? m[1] : ''
}

// ---------------------------------------------------------------------------
// 各类信号的判定（每个判定返回 { confidence, note } 或 null）
// ---------------------------------------------------------------------------

function detectSharedJoke({ userText, botText, recentContext }) {
  const userLaugh = firstMatch(LAUGH, userText)
  const botLaugh = firstMatch(LAUGH, botText)
  // ① 双方都在笑：最强证据（"哈哈哈哈" 对答）
  if (userLaugh && botLaugh) {
    return { confidence: 0.85, note: snippet(userText, userLaugh) }
  }
  // ② 复读/接梗的元话语 + 有笑（任一侧）
  const meta = firstMatch(JOKE_META, userText)
  if (meta && (userLaugh || botLaugh)) {
    return { confidence: 0.75, note: snippet(userText, meta) }
  }
  // ③ 引用旧梗：用户用引号提到某个梗，且这个梗在最近上下文里出现过
  const quoted = quotedFragment(userText)
  if (quoted && recentContext.includes(quoted) && (userLaugh || has(/又|还|上次|老梗|梗/, userText))) {
    const idx = userText.indexOf(quoted)
    return { confidence: 0.72, note: snippetAt(userText, idx, quoted.length) }
  }
  // ④ 用户复述 bot 的独特短语（长度 2~10 且带笑）：接住了对方的梗
  if (userLaugh && botText) {
    const words = botText.match(/[\u4e00-\u9fa5A-Za-z]{2,10}/g) || []
    for (const word of words) {
      if (userText.includes(word) && !/^(哈哈|嘿嘿|什么|这个|那个|可以|不是|就是)$/.test(word)) {
        const idx = userText.indexOf(word)
        return { confidence: 0.65, note: snippetAt(userText, idx, word.length) }
      }
    }
  }
  return null
}

function detectDeepTalk({ userText, botText, recentContext, now }) {
  const strong = firstMatch(DEEP_STRONG, userText)
  // ① 强自陈：本身就是"只跟你说"的话，无需长度条件
  if (strong) return { confidence: 0.8, note: snippet(userText, strong) }
  const emotion = firstMatch(DEEP_EMOTION, userText)
  const longEnough = userText.length >= 40 || botText.length >= 40
  const multiTurn = recentContext.length >= 40
  // ② 深夜（0–5 点）+ 掏心窝：深夜长聊的典型形态
  const hour = Number.isFinite(Number(now)) ? new Date(Number(now)).getHours() : -1
  if (emotion && hour >= 0 && hour <= 5) return { confidence: 0.8, note: snippet(userText, emotion) }
  // ③ 情绪自陈（说的是自己的内心状态）：单独出现就认，但置信度不过度自信
  if (emotion) return { confidence: 0.7, note: snippet(userText, emotion) }
  const weak = firstMatch(DEEP_WEAK, userText)
  if (!weak) return null
  // ④ 弱证据：必须长消息或多轮 + 有内心活动，否则「我妈让我早点睡」会被记成谈心
  if (!(longEnough || multiTurn)) return null
  if (!has(DEEP_FEELING, userText)) return null
  return { confidence: 0.65, note: snippet(userText, weak) }
}

function detectMutualHelp({ userText, botText }) {
  const thanks = firstMatch(THANKS, userText)
  // ① 道谢 + 对方确实给了实质帮助（不是客套"不客气"）
  if (thanks && has(HELP_GIVE, botText)) return { confidence: 0.75, note: snippet(userText, thanks) }
  // ② 道谢 + 明确说问题解决了（合作完成的闭环）
  if (thanks && has(SOLVED, userText)) return { confidence: 0.8, note: snippet(userText, thanks) }
  // ③ 明确求助 + 对方给出可执行建议
  const ask = firstMatch(HELP_ASK, userText)
  if (ask && has(HELP_GIVE, botText)) return { confidence: 0.7, note: snippet(userText, ask) }
  return null
}

function detectConflict({ userText }) {
  const strong = firstMatch(CONFLICT_STRONG, userText)
  // 打闹标记在场时，一切"冲突词"都按玩笑处理（宁可漏判）
  if (has(JOKE_SOFTENER, userText)) return null
  if (strong) return { confidence: 0.85, note: snippet(userText, strong) }
  // 弱证据必须凑够两条不同标记，单条一律不产（"你错了，我觉得应该这样"不该扣 2 分）
  if (countMild(userText) >= 2) {
    const mild = firstMatch(CONFLICT_MILD, userText)
    return { confidence: 0.78, note: snippet(userText, mild) }
  }
  return null
}

function detectBoundaryViolation({ userText, botText, recentContext }) {
  // 必要条件：**对方已经明确划界/拒绝**，否则一律不算越界（最保守的一类）
  const refusal = firstMatch(REFUSAL, botText) || firstMatch(REFUSAL, recentContext)
  if (!refusal) return null
  const push = firstMatch(PUSH, userText)
  if (push) return { confidence: 0.85, note: snippet(userText, push) }
  const demand = firstMatch(VIOLATION_DEMAND, userText)
  if (demand) return { confidence: 0.85, note: snippet(userText, demand) }
  return null
}

/** 转述别人的话（"她说你真好""他信任你"）：主语不是本人 → 不是本人认可关系。 */
const THIRD_PARTY = /(她|他|她们|他们|别人|人家|我朋友|我同事|我室友)/

function detectExplicitConfirmed({ userText }) {
  const confirm = firstMatch(CONFIRM, userText)
  if (!confirm) return null
  // 同一句里在开玩笑 → 不算（"你真好笑" 已被负向前瞻挡住，这里再兜一层整体语义）
  if (has(/(开玩笑|闹着玩|逗你)/, userText)) return null
  // 匹配点往前一小段里出现第三人称主语 = 转述别人的评价，不是本人认可
  const before = userText.slice(Math.max(0, confirm.index - 6), confirm.index)
  if (THIRD_PARTY.test(before)) return null
  return { confidence: 0.8, note: snippet(userText, confirm) }
}

const DETECTORS = Object.freeze({
  'shared-joke': detectSharedJoke,
  'deep-talk': detectDeepTalk,
  'mutual-help': detectMutualHelp,
  'conflict': detectConflict,
  'boundary-violation': detectBoundaryViolation,
  'explicit-confirmed': detectExplicitConfirmed,
})

/**
 * 从一轮对话里挖关系信号（纯函数、确定性、零 I/O）。
 *
 * @param {object} input
 * @param {string} [input.chatKey] 当前聊天域（`private:<uid>` / `group:<gid>`）。传了就必须合法：
 *   非法键按 fail-closed 返回 `[]`（图谱层同样会拒收，别在这里制造半个真理）。不传不猜作用域。
 * @param {string} [input.userText] 这一轮对方说的话（纯文本）
 * @param {string} [input.botText] 这一轮她的回复（纯文本）
 * @param {string} [input.recentContext] 最近若干轮的文字（用于"多轮""复读旧梗""被拒绝后继续"）
 * @param {number} [input.now] 时间戳（毫秒）；**不传就不做深夜判定**，绝不偷偷读 Date.now
 * @returns {Array<{kind: string, note: string, confidence: number}>}
 */
export function mineSignals({ chatKey, userText, botText, recentContext, now } = {}) {
  // 显式给了 chatKey 却判不出来：这个会话不可信，一律不产（调用方照样能安全地拿到 []）。
  // 只有「根本没传」（undefined）才算未声明作用域；null、''、裸数字、乱码一律按非法处理。
  if (chatKey !== undefined && !isChatKey(String(chatKey))) return []

  const ctx = {
    userText: normalizeText(userText),
    botText: normalizeText(botText),
    recentContext: normalizeText(recentContext),
    now,
  }
  // 两边都没有内容 → 没有可判定的证据
  if (!ctx.userText && !ctx.botText) return []

  const hits = new Map()
  for (const kind of SIGNAL_KINDS) {
    const hit = DETECTORS[kind](ctx)
    if (!hit) continue
    const confidence = Math.round(Math.min(1, Math.max(0, Number(hit.confidence) || 0)) * 100) / 100
    // 置信度低于该信号下限 → 直接丢弃（负面信号门槛更高）
    if (confidence < MIN_CONFIDENCE[kind]) continue
    hits.set(kind, { kind, note: String(hit.note || '').slice(0, MAX_NOTE_CHARS), confidence })
  }
  // 冲突/越界在场的这一轮不产出任何正向信号：吵架时顺口一句"谢谢"不该抵消关系损伤，
  // 也不该让一句气话里的"哈哈哈哈"变成"一起玩过梗"。（宁可漏判不可误判）
  const negative = hits.has('conflict') || hits.has('boundary-violation')
  const out = []
  for (const kind of SIGNAL_KINDS) {
    const hit = hits.get(kind)
    if (!hit) continue
    if (negative && POSITIVE_KINDS.has(kind)) continue
    out.push(hit)
  }
  return out
}

export default mineSignals