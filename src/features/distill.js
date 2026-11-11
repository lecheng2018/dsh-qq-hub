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
  catchphrases: 5, // 口头禅 + 使用语境：「斩」（随口催办时用）
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

/**
 * 提取「互动回执对」：别人说了什么 → 他怎么接（RFC 蒸馏群友重构 模块一）。
 * 光给他的原话，模型不知道每句是「在什么情境下脱口而出的」，提炼出来就是空中楼阁；
 * 这里的清洗规则：
 *   1. 剔除纯转发/链接/系统通知/超短拟声词（JUNK_RE + 最短长度）；
 *   2. 每条回复必须带上前 1~3 条里最近的一条「别人说的」当语境，凑不成对的不收；
 *   3. 截到 maxTurns 条为止——喂得再多模型也只看得见最后几屏。
 */
export function extractMeaningfulInteractions (lines, targetUid, { minLen = 3, maxTurns = 40 } = {}) {
  const want = String(targetUid || '').trim()
  if (!want) return []
  const rows = (lines || [])
    .map((l) => ({ ...l, t: Number(l.t ?? l.at) || 0, text: String(l.text || '').trim() }))
    .filter((l) => l.text && !l.text.startsWith('【系统') && !JUNK_RE.test(l.text))
    .sort((a, b) => a.t - b.t)
  const out = []
  for (let i = 1; i < rows.length && out.length < maxTurns; i++) {
    const cur = rows[i]
    if (String(cur.uid || '') !== want || cur.text.length < minLen || JUNK_RE.test(cur.text)) continue
    let prev = null
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (String(rows[j].uid || '') !== want && rows[j].text) { prev = rows[j]; break }
    }
    if (prev) out.push({ t: cur.t, prompt: `${prev.name || prev.uid || '群友'}：${String(prev.text).slice(0, 120)}`, response: cur.text })
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

export function buildDistillPrompt ({ name = '这个人', uid = '', memberLines = [], context = [], others = [], old = null, interactions = [] } = {}) {
  const who = String(name || '这个人').slice(0, 20)
  const said = (memberLines || []).slice(-120).map((x) => `他：${x.text.slice(0, 160)}`).join('\n')
  const convoLines = (context || []).slice(-160).map((x) => {
    if (typeof x === 'string') return x
    const text = String(x.text || '').slice(0, 120)
    return String(x.uid || '') === String(uid) ? `他：${text}` : `${x.name || ''}：${text}`
  })
  const convo = convoLines.join('\n')
  const contrast = (others || []).slice(-20).map((x) => String(x).slice(0, 100)).join('\n')
  const pairs = (interactions || []).slice(-24).map((x) => `- 对方：${String(x.prompt || '').slice(0, 120)}\n  他：${String(x.response || '').slice(0, 160)}`).join('\n')
  const oldText = old
    ? `\n已有的旧画像（同字段结构；新证据里仍成立的保留、被推翻的丢掉，合并成一份，别越写越多）：\n`
      + `dialogue_samples：${(old.exchanges || []).join(' ‖ ') || '（无）'}\n`
      + `typing_habits：${(old.syntax || []).join('；') || '（无）'}\n`
      + `tone_stance：${(old.rhetoric || []).join('；') || '（无）'}\n`
      + `negative_avoid：${(old.never || []).join('；') || '（无）'}\n`
    : ''
  return {
    // RFC 蒸馏群友重构 模块二：四维微画像（对话接话示范 / 打字节奏 / 态度倾向 / 负向边界）。
    // 与旧版的关键区别：只借「语言组织方式」，明令禁止把他的真实经历提炼成可模仿内容——
    // 旧版学出过「拿自己旧号被封的经历作证」这种模仿项，说了就是冒充本人。
    system: [
      '你是语言风格分析师，从一个真实 QQ 群友的历史发言里，提炼他最具辨识度的「说话节奏与语感风格」，给另一个 AI 在该群参考着说。',
      '只提炼语言组织方式（节奏、断句、口吻、接话套路）；绝不提炼他的个人经历、身份信息和具体生活事实。',
      '输出且仅输出一个合法 JSON 对象，不要 Markdown 围栏、不要任何解释或前后缀：',
      '{"dialogue_samples":["问：对方的话\\n答：他的原话（逐字保留）"],"typing_habits":["…"],"tone_stance":["…"],"negative_avoid":["…"]}',
      '',
      'dialogue_samples（最重要，2~3 条）：挑「别人问/说什么 → 他怎么接」的真实对话对。学的是接话的姿势与语调节奏；他的回答逐字保留，不改写。',
      'typing_habits（≤3 条）：打字节奏与习惯——短句还是长句、逗号/空格/换行怎么断、句号用不用、一条发完还是拆几条、@ 不 @ 人。每条 ≤25 字。',
      'tone_stance（≤3 条）：态度倾向——对求助、开玩笑、倒霉事、争议话题分别是什么姿态（如：遇到技术问题先给核心排查点；被开玩笑时轻微自嘲）。每条 ≤40 字。',
      'negative_avoid（≤4 条）：他从不用/不做的表达——如客服式客套话、编号分点长教程、卖萌表情。每条 ≤30 字。',
      '',
      '三条铁律：',
      '1. 只收高频共性：同一表达至少出现在两个不同对话里才算口头禅/习惯；单次突发事件里的专有名词（某次故障的行话）不算。',
      '2. 绝对禁止把他的真实经历提炼成「可模仿的内容」（如自己被封过号、买过什么、去过哪）——那些是身份事实，学了就是冒充本人。',
      '3. 证据不足的字段直接给空数组 []，严禁编造；换成一个泛用聊天者也成立的描述就删掉（自检误读）。',
    ].join('\n'),
    text: [
      `要学的人：${who}`,
      pairs ? `\n他回应别人的真实切片（dialogue_samples 从这里挑）：\n${pairs}` : '',
      said ? `\n他的原话（打字节奏/习惯的证据）：\n${said}` : '',
      convo ? `\n群聊原文（交错语境，用来确认他在回应什么）：\n${convo}` : '',
      contrast ? `\n群里别人说的话（对照出他的不同，不要学这些）：\n${contrast}` : '',
      oldText,
      '只输出 JSON 对象。',
    ].filter(Boolean).join('\n'),
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

/** 收成固定字段，去空、去重、截长度和条数（纯数字条目丢弃：旧版曾把句数存进 samples）。
 * 同时兼容 RFC 四维新 schema（dialogue_samples/typing_habits/tone_stance/negative_avoid）
 * 与 1.3.63 旧 schema（exchanges/syntax/catchphrases/rhetoric/never/persona）：新名字优先。 */
export function normalizeProfile (obj) {
  const pick = (v, cap, maxLen = 90) => {
    const list = Array.isArray(v) ? v : v ? [v] : []
    const seen = new Set()
    const out = []
    for (const x of list) {
      const t = String(x == null ? '' : x).trim().slice(0, maxLen)
      if (!t || /^\d+$/.test(t) || seen.has(t)) continue
      seen.add(t)
      out.push(t)
      if (out.length >= cap) break
    }
    return out
  }
  const o = obj || {}
  return {
    exchanges: pick(o.dialogue_samples || o.exchanges, FIELD_CAP.exchanges, 220),
    syntax: pick(o.typing_habits || o.syntax, FIELD_CAP.syntax),
    catchphrases: pick(o.catchphrases, FIELD_CAP.catchphrases),
    rhetoric: pick(o.tone_stance || o.rhetoric, FIELD_CAP.rhetoric, 160),
    never: pick(o.negative_avoid || o.never, FIELD_CAP.never),
    persona: pick(o.persona, FIELD_CAP.persona),
    // 旧字段兼容渲染（不再由新学习产出）
    style: pick(o.style, FIELD_CAP.style),
    tone: pick(o.tone, FIELD_CAP.tone),
    samples: pick(o.samples, FIELD_CAP.samples),
    avoid: pick(o.avoid, FIELD_CAP.avoid),
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
