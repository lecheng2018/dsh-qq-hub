// 群聊「读空气」：一群人正在聊的这一小段，有多冲、有多热。
//
// 以前要不要插话只看关键词命中（group-policy.interests），于是两种翻车很常见：
//   1. 群里正吵得凶，她凑上去接一句 —— 火上浇油，还容易被当靶子；
//   2. 群里在接龙复读刷屏，她再发一整段 —— 淹在刷屏里，显眼又没用。
// 这里只做纯算法：最近一小段窗口的张力（tension）与热度（energy），各折算成 0~1，
// 再给一句情境建议（advice）。它**不替代** group-policy 里既有的刹车
// （burst / maxPerHour / cooldownSec / quietHours 全部照旧生效），只在
// decideGroupReply 之前当一道情境门禁：高危冲突就别开口，刷屏狂欢就只极简共鸣。
//
// 阈值对齐计划书（v3.3-HARDENED 第七节）：
//   tension > 0.7 → stealth（绝对避险，保持沉默）
//   energy  > 0.8 → minimal_resonance（降级为极简共鸣）
//   疑问句 + 静默 > 20s → assist（没人接话，可以帮着接一下）
//   其余 → normal（照常按 group-policy 判定）
// advice 与 tone 用同一个比较符（都是严格大于）：同一份数值不会出现
// 「tone: conflict 但 advice: normal」这种自相矛盾的输出。
//
// 纯函数、无 IO、无随机：同样的消息窗口永远得到同样的结果，便于回放与单测。

/** advice 的全部取值。调用方可以拿它做断言或日志枚举。 */
export const ADVICE = Object.freeze(['stealth', 'minimal_resonance', 'assist', 'normal'])

export const DEFAULT_WINDOW = 10
export const DEFAULT_TENSION_LIMIT = 0.7
export const DEFAULT_ENERGY_LIMIT = 0.8
export const DEFAULT_SILENCE_MS = 20_000
// 窗口内平均每分钟多少条算「满热」。12 条/分钟 ≈ 5 秒一条，真人抢话大概就是这个密度。
export const DEFAULT_PACE_CEILING = 12

// 纯表情 / 纯 CQ 码（[CQ:face,id=178]）/ 纯段数组消息（{type:'face'}）在窗口里的占比，
// 单列一档权重。为什么必须单列：一条 QQ 表情里没有半个字，
// textOfSegments() 对 face/image 也取不出字，于是「复读度」「短梗」两项全是 0，
// 纯表情接龙的热度天花板被锁死在 0.45（无复读）~ 0.80（CQ 码可复读），
// 永远够不到 0.8 的 minimal_resonance 门槛。而表情接龙的热度本来就不在「说了什么」，
// 而在「一串一样的东西在刷」，所以按「纯媒体消息占比」再补一档。
const MEDIA_FLOOD_WEIGHT = 0.4

// 火药味词表：只放真正带攻击性/对抗性的词。
// 刻意不收「吵」「烦」「垃圾」「吵架」这类单字/日常词 ——
// 「这歌好吵」「这电影真垃圾」「他们又吵架了」全是吐槽或转述，不是开火。
// 「骂人」保留：它多半是对着人说的（「骂人你还挺有理」），
// 劝架语（「别骂人了」）由下面的 DEESCALATE 先行摘除。
const CONFLICT_WORDS = Object.freeze([
  '滚', '闭嘴', '傻逼', '傻子', '沙雕', '蠢', '有病', '神经病', '妈的', '他妈', '尼玛', '草泥马',
  '去死', '烦死', '恶心', '吵死', '少来', '拉黑', '退群', '不服', '骂人',
])

// 「垃圾」只在指着人骂时才算开火（「你就是个垃圾」），影评吐槽（「这电影真垃圾」）不算。
const DIRECTED_INSULT = /(?:你|您|他|她|它|这帮|这群|这人|那货|楼上|楼下|群主)[^，。！？!?]{0,4}?(?:垃圾|废物|傻|蠢|有病)/u

// 劝架 / 息事宁人：把「别吵架了」「你们都别骂人」这类措辞先摘掉，
// 剩下的才是真情绪。摘完什么都不剩 → 整句就是在劝架，不算开火。
const DEESCALATE = /(?:别|不要|甭|少)(?:再|老是|总是)?(?:吵|骂|打|闹|争|怼)[^，。！？!?]{0,4}(?:了|啊|吧|嘛|呢|行不行|好不好)?/gu

// 连打两个以上的问号/叹号 = 情绪上头（「滚！！」「你什么意思？？」）。单发的不算。
const SHOUT = /[!！?？]{2,}/
const CAPS = /[A-Z]{4,}/

// 热闹信号：笑、起哄、梗
const CHEER = new RegExp('[哈嘿嘻]{2,}|[hH]{3,}|233+|awsl|笑死|xswl|好耶|yyds')

// 疑问句：以问号结尾，或以疑问语气词收尾，或含独立疑问词
const QUESTION_TAIL = /[吗呢嘛]\s*[。.!！~～]?\s*$/u
// 「么」单独收尾才算（「有人么」），「什么」不算（「没什么」是陈述）
const SOFT_TAIL = /[^什]\s*么\s*[。.!！~～]?\s*$/u
const QUESTION_WORDS = Object.freeze([
  '怎么', '为什么', '为啥', '什么', '啥', '谁', '哪里', '哪个', '多少', '多久', '几点',
  '是不是', '要不要', '能不能', '有没有', '如何', '咋',
])
// 反诘式收尾：「谁说不是呢」「可不是嘛」带疑问字样，其实是陈述/附和
const RHETORIC_TAIL = /(?:谁说|谁不|可不|岂不|还不是|又不是|不是说)[^?？]{0,3}[呢吗嘛么]$/u
// 带疑问词但不是提问的固定搭配：整词摘掉后再找疑问词
const NON_QUESTION_PHRASE = Object.freeze([
  '没什么', '什么也', '什么都', '什么的', '算什么', '多少有点', '多少有些',
  '多少还是', '多多少少', '好不容易', '不管', '无论', '随便',
])

// CQ 码 / 尖括号段 / 文字占位符：OneBot 的字符串形态与 inbound.js 折叠出来的占位文本
const CQ_CODE = /\[CQ:([A-Za-z0-9_.-]+)[^\]]*\]/g
const ANGLE_SEG = /<(face|mface|image|emoji)(?::[^>]*)?>/gi
const PLACEHOLDER = /\[(表情包|表情|图片|语音|视频|卡片消息|合并转发|戳一戳|文件[^\]]*)\]/gu
const PLACEHOLDER_KIND = /\[(表情包|表情|图片|语音|视频)\]/u
const PICTO = /\p{Extended_Pictographic}/u
// 能当「表情/媒体」看的段类型
const MEDIA_TYPES = Object.freeze(['face', 'mface', 'image', 'emoji', 'record', 'video'])

const clamp01 = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// options 里的 null / undefined / 非数值（含 ''、NaN、Infinity）一律回落默认值。
// 老写法直接 Number(v)：Number(null) === 0，于是 window: null 静默退化成 1 条、
// energyLimit: null 变成「只要有热度就刷屏」，配置写错一个 null 就整条判定跑偏。
const num = (v, fallback) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return fallback
    const n = Number(s)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

/** 防御式取属性：抛异常的 getter（脏数据 / Proxy）不许冒泡到这里。 */
const safeGet = (o, k) => {
  try { return o == null ? undefined : o[k] } catch { return undefined }
}

const numOf = (o, k, fallback) => num(safeGet(o, k), fallback)

const isArrayLike = (v) => {
  try { return Array.isArray(v) } catch { return false }
}

/** 消息窗口 → 普通数组。数组本身是坏 Proxy 时也不要炸。 */
function toList (messages) {
  try {
    if (!Array.isArray(messages)) return []
    const out = []
    for (const m of messages) out.push(m)
    return out
  } catch { return [] }
}

/**
 * 段数组。真机要认三种形状：
 *   · `segments`：标准段数组（OneBot 事件 / normalized-inbound）；
 *   · `media`：group-state 缓冲条目专门挂的图片/表情段（`{ type:'image', url }`）；
 *   · `message`：整条 OneBot 事件原样塞进来时的段数组。
 * 为什么要专门认 media：缓冲条目的 `text` 来自 textOfSegments()，它对 face/image 段返回空串，
 * 只认 text 的话真实 QQ 表情刷屏永远是一屋子空字符串。
 */
function segmentsOf (m) {
  if (!m || typeof m !== 'object') return []
  const raw = safeGet(m, 'segments') ?? safeGet(m, 'segs') ?? safeGet(m, 'media') ?? safeGet(m, 'message')
  return isArrayLike(raw) ? raw : []
}

function segTypeOf (s) {
  return String(safeGet(s, 'type') || '')
}

/**
 * 段数组 → 文本（带占位符）。
 * 这条是本模块自己的兜底：textOfSegments() 对 face/image 段返回空串，
 * 只靠它取字的话，真实 QQ 表情刷屏永远是一屋子空文本，热度恒为 normal。
 */
function segmentsToText (segs) {
  const parts = []
  for (const s of segs) {
    const type = segTypeOf(s)
    if (!type) continue
    if (type === 'text') parts.push(String(safeGet(safeGet(s, 'data'), 'text') ?? ''))
    else if (type === 'face' || type === 'mface' || type === 'emoji') parts.push('[表情]')
    else if (type === 'image') parts.push('[图片]')
    else if (type === 'record') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'at' || type === 'reply') continue
    else parts.push(`[${type}]`)
  }
  return parts.join('')
}

/** 消息正文：兼容 { text } / { content } / { message } / { msg }、段数组与裸字符串。 */
function textOf (m) {
  try {
    if (typeof m === 'string') return m
    if (!m || typeof m !== 'object') return ''
    const raw = safeGet(m, 'text') ?? safeGet(m, 'content') ?? safeGet(m, 'message') ?? safeGet(m, 'msg')
    if (raw == null || String(raw).trim() === '') {
      const segs = segmentsOf(m)
      return segs.length ? segmentsToText(segs) : (raw == null ? '' : String(raw))
    }
    if (isArrayLike(raw)) return segmentsToText(raw)
    return String(raw)
  } catch { return '' }
}

/**
 * 消息时间戳（毫秒）：t / time / ts / timestamp / at，**只认数值**。
 *
 * 生产字段 at 是「这条消息有没有 @ 我」的布尔（at: false），
 * 旧实现把它当时间戳兜底：Number(false) === 0 → 最后一句被算成 1970 年发的 →
 * 静默无穷大 → 无条件 assist。布尔/字符串一律忽略。
 */
function timeOf (m) {
  if (!m || typeof m !== 'object') return null
  for (const k of ['t', 'time', 'ts', 'timestamp', 'at']) {
    const raw = safeGet(m, k)
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue
    // 秒级时间戳（OneBot 的 time 字段就是秒）转成毫秒，否则跨度算出来全是 0
    return raw < 1e11 ? raw * 1000 : raw
  }
  return null
}

/** 发言人：没有 uid 时退回昵称，只有「是不是同一个人」这一个用途。 */
function whoOf (m) {
  if (!m || typeof m !== 'object') return ''
  const v = safeGet(m, 'uid') ?? safeGet(m, 'userId') ?? safeGet(m, 'user_id') ?? safeGet(m, 'nick') ?? safeGet(m, 'nickname') ?? ''
  try { return String(v) } catch { return '' }
}

/** 复读判定用的指纹：去空白、去标点符号（含 emoji），忽略大小写。 */
function fingerprint (text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/** 剥掉 CQ 码 / 尖括号段 / 占位符 / 纯符号后，真正「说出来的字」。 */
function coreText (text) {
  return fingerprint(String(text || '').replace(CQ_CODE, '').replace(ANGLE_SEG, '').replace(PLACEHOLDER, ''))
}

/** 这条消息是不是纯表情/纯媒体（段数组、CQ 码、尖括号段、占位符、一屏 emoji 都算）。 */
function mediaKindOf (text, segs) {
  for (const s of segs) {
    const type = segTypeOf(s)
    if (MEDIA_TYPES.includes(type)) return type === 'emoji' ? 'face' : type
  }
  const s = String(text || '')
  const angle = /<(face|mface|image|emoji)(?::[^>]*)?>/i.exec(s)
  if (angle) {
    const k = angle[1].toLowerCase()
    return k === 'emoji' ? 'face' : k
  }
  const cq = /\[CQ:([A-Za-z0-9_.-]+)/i.exec(s)
  if (cq) {
    const k = cq[1].toLowerCase()
    if (MEDIA_TYPES.includes(k)) return k === 'emoji' ? 'face' : k
  }
  const ph = PLACEHOLDER_KIND.exec(s)
  if (ph) {
    if (ph[1] === '图片') return 'image'
    if (ph[1] === '语音') return 'record'
    if (ph[1] === '视频') return 'video'
    return 'face'
  }
  // 一屏 emoji、没有半个字 —— 也是表情接龙
  if (s.trim() && PICTO.test(s) && !coreText(s)) return 'face'
  return ''
}

/**
 * 单条消息的复读单元。
 * key 是「复读指纹」：有字就用字，没字就用媒体种类 ——
 * 表情接龙刷的本来是同一类段（一堆 face / 一堆图片），id 不同也算接龙。
 */
function unitOf (m) {
  const text = textOf(m)
  const segs = segmentsOf(m)
  const mediaKind = mediaKindOf(text, segs)
  const spoken = coreText(text)
  return {
    text,
    mediaKind,
    key: spoken || (mediaKind ? `#${mediaKind}` : ''),
    // 一个表情 / 一个 CQ 码本身就是「一句话」：刷屏时没人打长句
    short: spoken ? spoken.length <= 4 : Boolean(mediaKind),
    cheer: CHEER.test(text),
    // 纯媒体：整条消息里没有一个可读的字，热度全在「刷」上
    pureMedia: Boolean(mediaKind) && !spoken,
  }
}

function isHostile (text) {
  let s = String(text || '').trim()
  if (!s) return false
  // 先摘掉劝架措辞：「别吵架了」「你们都别骂人」剩下的才是情绪本身
  s = s.replace(DEESCALATE, '').trim()
  if (!s) return false
  if (DIRECTED_INSULT.test(s)) return true
  return CONFLICT_WORDS.some((w) => s.includes(w))
}

function isShouting (text) {
  const s = String(text || '')
  return (SHOUT.test(s) || CAPS.test(s)) && !QUESTION_TAIL.test(s)
}

function isQuestion (text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  // 问号是最硬的信号：「这游戏怎么玩？」「有人吗？」
  if (/[?？]/.test(raw)) return true
  const s = raw.replace(/[。.!！~～…\s]+$/u, '')
  if (!s) return false
  // 反诘/附和：「谁说不是呢」「可不是嘛」不是提问
  if (RHETORIC_TAIL.test(s)) return false
  if (QUESTION_TAIL.test(s) || SOFT_TAIL.test(s)) return true
  // 疑问词必须「独立」才算：先摘掉「没什么 / 多少有点」这类非疑问搭配
  let rest = s
  for (const p of NON_QUESTION_PHRASE) rest = rest.split(p).join('')
  if (!rest) return false
  return QUESTION_WORDS.some((w) => rest.includes(w))
}

function isCheer (text) {
  return CHEER.test(String(text || ''))
}

/**
 * 群聊张力与热度评估。
 *
 * @param {Array<object|string>} messages 群消息窗口（旧 → 新）。条目形如
 *   `{ t: 毫秒时间戳, uid, nick, text }`（group-state 的缓冲条目直接可用），
 *   也接受 `{ segments: [...] }`（只有段、没有字的表情/图片消息）与裸字符串。
 * @param {object} [options]
 * @param {number} [options.window=10]          只看最近多少条（默认 10）
 * @param {number} [options.now=Date.now()]     现在（判静默用）
 * @param {number} [options.silenceMs=20000]    静默多久算「没人接话」
 * @param {number} [options.tensionLimit=0.7]   超过就 stealth
 * @param {number} [options.energyLimit=0.8]    超过就 minimal_resonance
 * @param {number} [options.paceCeiling=12]     窗口内每分钟多少条算热度满格
 * @returns {{tension: number, energy: number, tone: string, advice: string, reason: string}}
 *   tension / energy 恒为 [0,1] 内的有限数；tone 取 conflict / hype / tense / lively /
 *   question / quiet / casual；advice 取 ADVICE 之一。
 */
export function evaluate (messages, options = {}) {
  const opt = options && typeof options === 'object' ? options : {}
  const list = toList(messages)
  const windowSize = Math.max(1, Math.floor(numOf(opt, 'window', DEFAULT_WINDOW)))
  const now = numOf(opt, 'now', Date.now())
  const silenceLimit = Math.max(0, numOf(opt, 'silenceMs', DEFAULT_SILENCE_MS))
  const tensionLimit = clamp01(numOf(opt, 'tensionLimit', DEFAULT_TENSION_LIMIT))
  const energyLimit = clamp01(numOf(opt, 'energyLimit', DEFAULT_ENERGY_LIMIT))
  const paceCeiling = Math.max(1, numOf(opt, 'paceCeiling', DEFAULT_PACE_CEILING))

  const win = list.slice(-windowSize)
  const units = win.map(unitOf)
  const texts = units.map((u) => u.text)
  const n = win.length

  // ---- 张力：多少条在开火、有没有互怼、最后一句是不是还在气头上 ----
  const hostileIdx = []
  texts.forEach((t, i) => { if (isHostile(t)) hostileIdx.push(i) })
  const conflictRatio = n ? hostileIdx.length / n : 0
  // ×1.2：窗口里 8 成以上在开火就按满格算，不要求条条带脏字
  const heat = clamp01(conflictRatio * 1.2)
  const shoutingRatio = n ? texts.filter(isShouting).length / n : 0
  const hostileSenders = new Set(hostileIdx.map((i) => whoOf(win[i])).filter(Boolean))
  // 两个以上的人在开火才算「互怼」；一个人自说自话发火只算情绪，不算冲突
  const duel = hostileSenders.size >= 2 ? 1 : 0
  const lastHostile = n && hostileIdx.includes(n - 1) ? 1 : 0
  // 样本太少不敢下结论：窗口里只有一两条时，把张力按条数打折（一条「滚！！」不该判成吵架）
  const confidence = clamp01(n / 3)
  const tension = clamp01((0.5 * heat + 0.2 * shoutingRatio + 0.15 * duel + 0.15 * lastHostile) * confidence)

  // ---- 热度：刷得多快、复读多密、多少短梗/起哄、纯表情占了多少 ----
  const times = win.map(timeOf).filter((t) => t !== null)
  let paceScore = 0
  if (times.length >= 2) {
    const span = Math.max(1000, Math.max(...times) - Math.min(...times))
    const perMinute = (times.length - 1) / (span / 60_000)
    paceScore = clamp01(perMinute / paceCeiling)
  }
  const keys = units.map((u) => u.key).filter(Boolean)
  const repeatRatio = keys.length
    ? clamp01(((keys.length - new Set(keys).size) / keys.length) * 1.2)
    : 0
  const shortRatio = n ? units.filter((u) => u.short).length / n : 0
  const cheerRatio = n ? units.filter((u) => u.cheer).length / n : 0
  // 纯表情/纯 CQ 码占比：一条表情没有字，复读度和短梗度都拿不到分，这里单独补一档
  const mediaRatio = n ? units.filter((u) => u.pureMedia).length / n : 0
  // 与张力同一条纪律：样本太少（一两条）不轻易判「刷屏」——
  // 「2 条表情」跟「2 条 1」一样不该惊动她，3 条以上才按满格算
  const energy = clamp01(
    (0.45 * paceScore + 0.35 * repeatRatio + 0.1 * shortRatio + 0.1 * cheerRatio + MEDIA_FLOOD_WEIGHT * mediaRatio) * confidence,
  )

  // ---- 静默与疑问：没人接的问句，正是她该帮一句的时候 ----
  const lastText = n ? texts[n - 1] : ''
  const lastTime = n ? timeOf(win[n - 1]) : null
  // 没有（数值）时间戳就当不知道沉默多久，不拿它下判断
  const silence = lastTime === null ? 0 : Math.max(0, now - lastTime)
  const silent = silence > silenceLimit
  const question = isQuestion(lastText)

  let advice = 'normal'
  if (tension > tensionLimit) advice = 'stealth'
  else if (energy > energyLimit) advice = 'minimal_resonance'
  else if (question && silent) advice = 'assist'

  // tone 与 advice 用同一个比较符（严格大于），同值时不出现「conflict + normal」
  let tone = 'casual'
  if (tension > tensionLimit) tone = 'conflict'
  else if (energy > energyLimit) tone = 'hype'
  else if (tension >= 0.5) tone = 'tense'
  else if (energy >= 0.5) tone = 'lively'
  else if (question) tone = 'question'
  else if (silent) tone = 'quiet'

  return {
    tension,
    energy,
    tone,
    advice,
    reason: describe({ advice, tension, energy, tensionLimit, energyLimit, question, silence, silent, n }),
  }
}

function describe ({ advice, tension, energy, tensionLimit, energyLimit, question, silence, silent, n }) {
  if (!n) return '窗口里没有消息'
  if (advice === 'stealth') return `群里在吵（张力 ${tension.toFixed(2)} > ${tensionLimit}），先闭嘴`
  if (advice === 'minimal_resonance') return `接龙刷屏中（热度 ${energy.toFixed(2)} > ${energyLimit}），只极简共鸣`
  if (advice === 'assist') return `提问没人接（静默 ${(silence / 1000).toFixed(0)}s），可以帮一句`
  if (question && !silent) return '刚有人提问，等一会儿看有没有人接'
  return `氛围平稳（张力 ${tension.toFixed(2)}，热度 ${energy.toFixed(2)}）`
}
