// 蒸馏群友（1.3.59）：指定某个群里的某一个人当数据源，学他的说话方式、性格、语气。
//
// 和「群黑话本」是两件事：黑话本学的是**词**（这个群在用什么梗），蒸馏群友学的是**人**
// （这个人怎么说话、什么脾气、对谁什么态度）。本文件只管纯逻辑：从聊天流水里捞这个人的话、
// 拼提炼提示词、解析模型结果、合并新旧画像、渲染注入文本。存储与模型调用在 features/memory.js。
//
// 一条硬边界（写进注入文本，也写进提示词）：**学的是说话的样子，不是冒充这个人**。
// 她在群里用相似的语感、句长、口头禅，但绝不声称自己是对方、也不替对方表态。
//
// 设计依据（2026-11-06 查证）：
//   · arXiv 2410.03848「Using Prompts to Guide LLMs in Imitating a Real Person's Language Style」：
//     效果最好的做法是**把原文样本放进提示词**，光给「特征描述」不够；ToT（多写几版再投票）更强但成本高。
//   · molroo 的 Speaking Style：建议 **20~30 条样本**才可靠；profile 分词汇/结构/标点/语域四类；
//     提取时可传 otherMessages 做对照（靠「他和别人不一样在哪」定位）。
//   · writing-style-extractor / Style Extraction Prompt 的「Test for misreading」：
//     一条描述如果换成谁都能成立，就是废描述，必须删掉。
//   所以这里：samples 存逐字原话（主信号）、style/persona/tone 存特征（辅助）、avoid 存负向约束，
//   注入时原话优先——纯特征清单模仿不到具体的口头禅和节奏。

// 模板结构照业界蒸馏做法重构（1.3.63，2026-11-06 查证）：
//   · SillyTavern 角色卡（sillycard.xyz 字段指南 2/5）：mes_example 示例对话是教
//     「语气、节奏、称呼习惯」的最强手段——教**怎么接话**，不是只教说什么；
//     personality 写「可观察行为」不写空形容词（an anchor, not the whole novel）。
//   · vox-machina 人声模板：SENTENCE ARCHITECTURE（句子怎么搭）、口头禅带**使用语境**
//     （Signature phrase: "xx" (什么时候说什么用)）、NEVER-use 词表、DO NOT 边界清单。
//   · Digital_Twin_Rag：few-shot 样例 **1~2 条就够**，明确「绝不逐字引用」，只校准
//     tone/cadence/vocabulary。
//   · arXiv 2410.03848：原文样本进提示词优于特征描述（上一轮已采纳，保留 samples）。
const FIELD_CAP = {
  exchanges: 3, // 问答对话对（谁问了什么→他怎么答），最强风格信号
  syntax: 3, // 句子架构：长短句怎么搭、标点断句、@ 与开头习惯
  catchphrases: 5, // 口头禅 + 使用语境：「搞」（随口催办时用）
  rhetoric: 3, // 修辞招式：自嘲、玩梗、反问……各配一个真实例子
  never: 4, // 从不用的词和从不做的行为（防通用聊天腔渗入）
  persona: 4, // 性格锚：可观察行为，不写「他很友善」式空话
  // 旧字段（1.3.60~1.3.63 存量画像兼容渲染用，新学习不再产出）
  style: 6, tone: 4, samples: 5, avoid: 3,
}

// 纯转发的卡片/图片/链接不是「他本人在说话」，喂给模型只会稀释证据
const JUNK_RE = /^\[(分享卡片|图片|动画表情|表情包|视频|文件)[^\]]*\]\s*$|^https?:\/\/\S+\s*$/

/** 从这个群的流水里挑出目标那个人说的话：滤掉纯转发、去重（同一条转发了 14 遍只算一句）、按时间正序。 */
export function collectMemberLines (lines, uid) {
  const want = String(uid || '').trim()
  if (!want) return []
  const seen = new Set()
  const out = []
  for (const l of (lines || []).slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))) {
    if (!l || !l.text || String(l.uid || '') !== want) continue
    const text = String(l.text).trim()
    if (!text || text.startsWith('【系统') || JUNK_RE.test(text)) continue
    if (seen.has(text)) continue // 复读转发只留第一次
    seen.add(text)
    out.push({ t: Number(l.t) || 0, text })
  }
  return out
}

/** 话太少就不值得花一次模型调用（学出来也是瞎猜）。门槛 20 句对齐 molroo 的 20~30 条建议。 */
export function enoughEvidence (memberLines, { minMessages = 20, minChars = 120 } = {}) {
  const list = memberLines || []
  if (list.length < minMessages) return false
  return list.reduce((n, x) => n + x.text.length, 0) >= minChars
}

/** 拼提炼提示词：给他本人的原话（带上下文中的别人一句，帮助判断他在回应什么）。 */
// dedupConvo 挪到了 chat/fish-guard.js（防刷屏工具归防刷屏模块），这里 re-export 保持既有调用方
export { dedupConvo } from '../chat/fish-guard.js'

export function buildDistillPrompt ({ name = '这个人', uid = '', memberLines = [], context = [], others = [], old = null } = {}) {
  const who = String(name || '这个人').slice(0, 20)
  const said = (memberLines || []).slice(-120).map((x) => `他：${x.text.slice(0, 160)}`).join('\n')
  // 交错的群聊原文（含别人和他），用来挑「一问一答」对话对；按 uid 标出「他：」
  const want = String(uid || '')
  const isHim = (x) => want && String((x && x.uid) || '') === want
  const convoLines = (context || []).slice(-160).map((x) => {
    if (typeof x === 'string') return x
    const text = String(x.text || '').slice(0, 120)
    return isHim(x) ? `他：${text}` : `${x.name || ''}：${text}`
  })
  const convo = convoLines.join('\n')
  const contrast = (others || []).slice(-20).map((x) => String(x).slice(0, 100)).join('\n')
  const oldText = old
    ? `\n已有的旧画像（新证据里仍成立的保留、被推翻的丢掉，合并成一份，别越写越多）：\n`
      + `句子架构：${(old.syntax || []).join('；') || '（无）'}\n`
      + `口头禅：${(old.catchphrases || []).join('；') || '（无）'}\n`
    : ''
  return {
    system: [
      '你是语言风格分析师，擅长把「一个具体的人」蒸馏成可执行的模仿模板（参照角色卡工程的做法：',
      '示例对话 > 形容词，行为 > 标签）。给你他在 QQ 群里的发言和群聊原文，输出 JSON 对象：',
      '{"exchanges":[...],"syntax":[...],"catchphrases":[...],"rhetoric":[...],"never":[...],"persona":[...]}',
      '',
      'exchanges（最重要）：从群聊原文里挑 2~3 组**一问一答**——别人问/说什么、他怎么接。',
      '  格式一组一条字符串："问：\u201c对方的话（可截短）\u201d\n答：\u201c他的原话（逐字，别改写）\u201d"。',
      '  要能看出他的接话方式（先 @ 谁、语气词怎么带、答多长）。没有一问一答就退化成「他说：\u201c…\u201d」独立句。',
      'syntax（句子架构）：句子长短怎么搭、用什么断句（逗号串/空格/换行）、开头习惯',
      '  （先 @ 人？先喊兄弟们？）、一条说完还是分几条。每条不超过 25 字。',
      'catchphrases（口头禅）：格式 `词/句式（什么时候用）`，如「搞（随口催办时）」「我看看（答应看一眼时）」。',
      'rhetoric（修辞招式）：他反复用的表达套路，3 条内，每条带一个真实例子的短引用。',
      'never（从不用）：他从不用的词（如感谢/请问/抱歉）、从不做的行为（分点写教程、卖萌表情）。',
      'persona（性格锚）：2~4 条**可观察行为**（如「出问题就自嘲」），不许写「他很友善」这种换成谁都成立的话。',
      '',
      '三条硬规矩：1) 每条都要能在上面原话/原文里找到依据，找不到依据的不写；',
      '2) 自检：换成群里另一个人也成立的就删；3) 证据不足的字段给空数组，不要编。',
      '只输出 JSON 对象，正文别加分析。',
    ].join('\n'),
    text: `要学的人：${who}\n\n他的原话：\n${said}\n\n`
      + (convo ? `群聊原文（用来挑一问一答的对话对，他的回答在原文里标了「他：」）：\n${convo}\n\n` : '')
      + (contrast ? `群里别人说的话（用来对照出他跟别人的不同，不要学这些）：\n${contrast}\n\n` : '')
      + oldText
      + '只输出 JSON 对象。',
  }
}

/** 解析模型回包：容忍 ```json 围栏、外面带解释、思考模型残留的开场白。 */
export function parseDistillProfile (raw) {
  let t = String(raw == null ? '' : raw).trim()
  if (!t) return null
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(t.slice(start, end + 1))
    return normalizeProfile(obj)
  } catch (error) {
    return null
  }
}

/** 收成固定字段，去空、去重、截长度和条数（纯数字条目丢弃：旧版曾把句数存进 samples）。 */
export function normalizeProfile (obj) {
  const pick = (v, cap) => {
    const list = Array.isArray(v) ? v : v ? [v] : []
    const seen = new Set()
    const out = []
    for (const x of list) {
      const t = String(x == null ? '' : x).trim().slice(0, 90)
      if (!t || /^\d+$/.test(t) || seen.has(t)) continue
      seen.add(t)
      out.push(t)
      if (out.length >= cap) break
    }
    return out
  }
  return {
    exchanges: pick(obj && obj.exchanges, FIELD_CAP.exchanges),
    syntax: pick(obj && obj.syntax, FIELD_CAP.syntax),
    catchphrases: pick(obj && obj.catchphrases, FIELD_CAP.catchphrases),
    rhetoric: pick(obj && obj.rhetoric, FIELD_CAP.rhetoric),
    never: pick(obj && obj.never, FIELD_CAP.never),
    persona: pick(obj && obj.persona, FIELD_CAP.persona),
    // 旧字段兼容渲染（不再由新学习产出）
    style: pick(obj && obj.style, FIELD_CAP.style),
    tone: pick(obj && obj.tone, FIELD_CAP.tone),
    samples: pick(obj && obj.samples, FIELD_CAP.samples),
    avoid: pick(obj && obj.avoid, FIELD_CAP.avoid),
  }
}

/** 合并新旧画像：新的在前，同一条（完全相同的文字）去重，超上限截断。 */
export function mergeProfile (old, incoming, cap = FIELD_CAP) {
  const a = normalizeProfile(old || {})
  const b = normalizeProfile(incoming || {})
  const merge = (x, y, n) => {
    const out = []
    const seen = new Set()
    for (const item of [...y, ...x]) {
      if (!item || seen.has(item)) continue
      seen.add(item)
      out.push(item)
      if (out.length >= n) break
    }
    return out
  }
  return {
    exchanges: merge(a.exchanges, b.exchanges, cap.exchanges),
    syntax: merge(a.syntax, b.syntax, cap.syntax),
    catchphrases: merge(a.catchphrases, b.catchphrases, cap.catchphrases),
    rhetoric: merge(a.rhetoric, b.rhetoric, cap.rhetoric),
    never: merge(a.never, b.never, cap.never),
    persona: merge(a.persona, b.persona, cap.persona),
    style: merge(a.style, b.style, cap.style),
    tone: merge(a.tone, b.tone, cap.tone),
    samples: merge(a.samples, b.samples, cap.samples),
    avoid: merge(a.avoid, b.avoid, cap.avoid),
  }
}

/**
 * 渲染成注入给她的那段话。
 * @returns {string} 空字符串表示没学到东西
 */
export function renderDistillHint (name, profile) {
  const p = normalizeProfile(profile || {})
  const has = p.exchanges.length || p.syntax.length || p.catchphrases.length || p.persona.length || p.samples.length || p.style.length
  if (!has) return ''
  const who = String(name || '这个人').slice(0, 20)
  const blocks = []
  // 业界的强度排序：对话对 > 口头禅/架构/修辞 > 独立原话（旧存量）> 特征描述
  if (p.exchanges.length) blocks.push('他怎么接话（学的是应对方式，内容绝不照搬）：\n' + p.exchanges.map((x) => '- ' + x).join('\n'))
  const voiceBits = []
  if (p.catchphrases.length) voiceBits.push('口头禅：' + p.catchphrases.join('；'))
  if (p.syntax.length) voiceBits.push('句子：' + p.syntax.join('；'))
  if (p.rhetoric.length) voiceBits.push('招式：' + p.rhetoric.join('；'))
  if (voiceBits.length) blocks.push(voiceBits.join('｜'))
  if (p.never.length) blocks.push('他从不：' + p.never.join('；'))
  if (p.persona.length) blocks.push('他是这样的人：' + p.persona.join('；'))
  if (p.samples.length) blocks.push('他的原话（校准节奏用，绝不照抄内容）：' + p.samples.map((x) => '「' + x + '」').join(' '))
  if (p.style.length) blocks.push('旧特征：' + p.style.join('；') + (p.tone.length ? '｜' + p.tone.join('；') : ''))
  if (p.avoid.length) blocks.push('他不会：' + p.avoid.join('；'))
  return `（群友语感参照「${who}」——在这个群里回话时照着他的接法来，拿不准才回自己的口吻。\n${blocks.join('\n')}\n`
    + `只借说话的方式，不借身份：你不是${who}本人，别自称他、别替他表态。）`
}
