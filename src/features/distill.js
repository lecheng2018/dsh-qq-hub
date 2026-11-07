import { statsToPrompt } from './style-stats.js'
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
  // ── 形式层（Style）：打字习惯与词汇指纹 ──
  rhythm: 4, // 节奏与排版：空格代逗号？换行拆句？句尾留白/省略号/问号连打？
  sentenceTemplates: 4, // 句式模板：条件触发的起手式（「差不多得了，…」「纯纯…」）
  styleRules: 5, // 排版硬规则：单条均长、断句、标点倾向（可执行，如「句尾从不带标点」）
  catchphrases: 5, // 词汇指纹：口头禅+触发语境+使用概率约束（防复读机）
  // ── 交互层（Interaction）：触发反响 ──
  reactions: 5, // 被@时/被反驳时/遇到离谱问题时：第一反应是什么
  mood: 3, // 情绪底色：冷淡/元气/摆烂/嘴硬心软……（带真实短例）
  // ── 认知层（Cognition）：决策偏好 ──
  cognition: 3, // 面对不确定性激进还是保守、争论中站哪方、看重什么
  identity: 2, // 他是谁（角色与关注点，背景参照）
  // ── 技能层（Fact Memory）不进人设卡——外挂知识库，另行处理 ──
  // 旧字段（1.3.60~63 存量兼容渲染）
  exchanges: 3, syntax: 3, rhetoric: 3, never: 3, persona: 4, style: 6, tone: 4, samples: 5, avoid: 3,
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

export function buildDistillPrompt ({ name = '这个人', uid = '', memberLines = [], context = [], others = [], old = null, stats = null } = {}) {
  const who = String(name || '这个人').slice(0, 20)
  const said = (memberLines || []).slice(-120).map((x) => `他：${x.text.slice(0, 160)}`).join('\n')
  const statsBlock = stats ? (typeof stats === 'string' ? stats : statsToPrompt(stats)) : ''
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
      + `排版规则：${(old.styleRules || []).join('；') || '（无）'}\n`
      + `口头禅：${(old.catchphrases || []).join('；') || '（无）'}\n`
      + `触发反响：${(old.reactions || []).join('；') || '（无）'}\n`
    : ''
  return {
    system: [
      '你是语言风格蒸馏器。任务：把「一个具体的人」在群里的说话方式拆成**四层结构**，',
      '让另一个 AI 只借「腔调」而不借「身份与事实」。严禁记忆他聊过的具体事实（项目名、群号、',
      '账号经历）——那些属于技能层，另行处理，混进来就是「皮骨混淆」。',
      '',
      '输出 JSON 对象（字段按层）：',
      '{"rhythm":[...],"sentenceTemplates":[...],"styleRules":[...],"catchphrases":[...],"reactions":[...],"mood":[...],"cognition":[...],"identity":[...]}',
      '',
      '── 形式层 ──',
      'rhythm（节奏与排版，群聊精髓在呼吸感）：他习惯空格代逗号、还是从头到尾不打标点、',
      '  还是句尾带 ... 或问号连打 ？？？？；会不会把一句话拆成两截中间换行。每条可执行。',
      'sentenceTemplates（句式模板，条件触发）：不能只列词，要列**句式逻辑**——',
      '  质疑/嘲讽起手式（「差不多得了，…」「纯纯…」「想啥呢，…」）、给结论的套路、',
      '  拒绝/应付的固定句式。每条 = 触发场景 + 句式骨架（真实例子填充）。',
      'styleRules（排版硬规则，可执行）：单条均长（对照统计锚点）、连发节奏。',
      'catchphrases（词汇指纹）：格式 `词（什么时候用+频率）`。频率必须标：高频/偶发/仅出现过一次。',
      '  偶发词严禁写成高频——这是防复读机的关键。',
      '',
      '── 交互层 ──',
      'reactions（触发反响）：被 @ 时、被反驳时、遇到离谱问题时他的第一反应',
      '  （先发「？」？直接开怼？阴阳怪气？公事公办解答？）。每条带真实短例。',
      'mood（情绪底色）：冷淡/元气/摆烂/嘴硬心软/好为人师——2~3 条，带真实短例，不写空形容词。',
      '',
      '── 认知层 ──',
      'cognition（决策偏好）：面对不确定激进还是保守、争论常站哪方、看重敏捷还是稳健。证据不足给空。',
      '',
      '── 背景参照 ──',
      'identity（他是谁）：1~2 条角色与关注点。注意：这只是背景，绝不许写进 styleRules/reactions——',
      '  「盯着什么额度」不是说话方式。',
      '',
      '三条硬规矩：',
      '1) 严禁记忆具体事实：账号经历、项目链接、群号、交易细节一律不入任何字段。',
      '2) 自检：每条换成群里另一个人试一遍，成立就删。',
      '3) 证据不足的字段给空数组，不要编。只输出 JSON 对象。',
    ].join('\n'),    text: `要学的人：${who}\n\n他的原话：\n${said}\n\n`
      + (convo ? `群聊原文（用来挑一问一答的对话对，他的回答在原文里标了「他：」）：\n${convo}\n\n` : '')
      + (contrast ? `群里别人说的话（用来对照出他跟别人的不同，不要学这些）：\n${contrast}\n\n` : '')
      + (statsBlock ? statsBlock + '\n\n' : '')
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
  if (start < 0) return null
  // 先按「最外层 } 结尾」试
  const end = t.lastIndexOf('}')
  const candidates = []
  if (end > start) candidates.push(t.slice(start, end + 1))
  // 再试「截断修复」：思考模型/长回包被 maxTokens 截断时，JSON 缺尾部括号。
  // 逐字符回退：丢掉残缺的尾部片段（半个字符串、半个键），然后按栈补齐 ] 和 }。
  // 只用于「完全解析失败」的兜底，成功的那条原样返回。
  const body = t.slice(start)
  let inStr = false
  let esc = false
  let depth = 0
  let lastSafe = -1 // 最后一个「结构安全」位置（不在字符串内、括号平衡点）
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '[' || ch === '{') { depth++; continue }
    if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) lastSafe = i
      continue
    }
  }
  // 截断修复：从尾部往前找最后一个「不在字符串里的 ] 或 }」（最后一个完整闭合的元素），
  // 截到那里，然后按栈补齐外层括号。lastSafe（整体闭合点）对截断回包永远不存在。
  {
    let cutEnd = -1
    const spans = [] // 字符串区间 [start, end)
    let s2 = false
    let strStart = 0
    let e2 = false
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (e2) { e2 = false; continue }
      if (ch === '\\') { e2 = true; continue }
      if (ch === '"') { if (s2) spans.push([strStart, i + 1]); s2 = !s2; if (s2) strStart = i }
    }
    const inStrAt = (i) => spans.some(([a, b]) => i >= a && i < b)
    for (let i = body.length - 1; i > 0; i -= 1) {
      const ch = body[i]
      if ((ch === ']' || ch === '}') && !inStrAt(i)) { cutEnd = i; break }
    }
    if (cutEnd > 0) {
      const cut = body.slice(0, cutEnd + 1)
      // 重算栈与字符串状态
      const stack = []
      let inS = false
      let escp = false
      for (let i = 0; i < cut.length; i++) {
        const ch = cut[i]
        if (escp) { escp = false; continue }
        if (ch === '\\') { escp = true; continue }
        if (ch === '"') { inS = !inS; continue }
        if (inS) continue
        if (ch === '[' || ch === '{') stack.push(ch)
        else if (ch === ']' || ch === '}') stack.pop()
      }
      let fixed = cut
      if (inS) fixed += '"'          // 截断点在字符串里：先补引号
      fixed = fixed.replace(/,\s*$/, '') // 挂着的逗号去掉
      while (stack.length) {
        const open = stack.pop()
        fixed += open === '[' ? ']' : '}'
      }
      candidates.push(fixed)
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      return normalizeProfile(obj)
    } catch (error) { /* 试下一个 */ }
  }
  return null
}

/** 收成固定字段，去空、去重、截长度和条数（纯数字条目丢弃：旧版曾把句数存进 samples）。 */
export function normalizeProfile (obj) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[\s，。；、""''「」（）()]/g, '')
  const pick = (v, cap) => {
    const list = Array.isArray(v) ? v : v ? [v] : []
    const seen = new Set()
    const out = []
    for (const x of list) {
      const t = String(x == null ? '' : x).trim().slice(0, 90)
      if (!t || /^\d+$/.test(t)) continue
      const k = norm(t)
      if (!k || seen.has(k)) continue // 归一后重复（含标点差异）视为同一条
      seen.add(k)
      out.push(t)
      if (out.length >= cap) break
    }
    return out
  }
  return {
    // 四层结构
    rhythm: pick(obj && obj.rhythm, FIELD_CAP.rhythm),
    sentenceTemplates: pick(obj && obj.sentenceTemplates, FIELD_CAP.sentenceTemplates),
    styleRules: pick(obj && obj.styleRules, FIELD_CAP.styleRules),
    catchphrases: pick(obj && obj.catchphrases, FIELD_CAP.catchphrases),
    reactions: pick(obj && obj.reactions, FIELD_CAP.reactions),
    mood: pick(obj && obj.mood, FIELD_CAP.mood),
    cognition: pick(obj && obj.cognition, FIELD_CAP.cognition),
    identity: pick(obj && obj.identity, FIELD_CAP.identity),
    // 旧字段兼容（存量渲染；含被覆盖成数字的 samples）
    exchanges: pick(obj && obj.exchanges, FIELD_CAP.exchanges),
    syntax: pick(obj && obj.syntax, FIELD_CAP.syntax),
    rhetoric: pick(obj && obj.rhetoric, FIELD_CAP.rhetoric),
    never: pick(obj && obj.never, FIELD_CAP.never),
    persona: pick(obj && obj.persona, FIELD_CAP.persona),
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
  const A = normalizeProfile(a)
  const B = normalizeProfile(b)
  return {
    rhythm: merge(A.rhythm, B.rhythm, cap.rhythm),
    sentenceTemplates: merge(A.sentenceTemplates, B.sentenceTemplates, cap.sentenceTemplates),
    styleRules: merge(A.styleRules, B.styleRules, cap.styleRules),
    catchphrases: merge(A.catchphrases, B.catchphrases, cap.catchphrases),
    reactions: merge(A.reactions, B.reactions, cap.reactions),
    mood: merge(A.mood, B.mood, cap.mood),
    cognition: merge(A.cognition, B.cognition, cap.cognition),
    identity: merge(A.identity, B.identity, cap.identity),
    exchanges: merge(A.exchanges, B.exchanges, cap.exchanges),
    syntax: merge(A.syntax, B.syntax, cap.syntax),
    rhetoric: merge(A.rhetoric, B.rhetoric, cap.rhetoric),
    never: merge(A.never, B.never, cap.never),
    persona: merge(A.persona, B.persona, cap.persona),
    style: merge(A.style, B.style, cap.style),
    tone: merge(A.tone, B.tone, cap.tone),
    samples: merge(A.samples, B.samples, cap.samples),
    avoid: merge(A.avoid, B.avoid, cap.avoid),
  }
}

/**
 * 渲染成注入给她的那段话。
 * @returns {string} 空字符串表示没学到东西
 */
export function renderDistillHint (name, profile) {
  const p = normalizeProfile(profile || {})
  const has = p.rhythm.length || p.sentenceTemplates.length || p.styleRules.length || p.catchphrases.length || p.reactions.length || p.mood.length || p.cognition.length || p.identity.length || p.exchanges.length || p.syntax.length || p.persona.length || p.samples.length || p.style.length
  if (!has) return ''
  const who = String(name || '这个人').slice(0, 20)
  const blocks = []
  // 业界的强度排序：对话对 > 口头禅/架构/修辞 > 独立原话（旧存量）> 特征描述
  if (p.exchanges.length) blocks.push('他怎么接话（学的是应对方式，内容绝不照搬）：\n' + p.exchanges.map((x) => '- ' + x).join('\n'))
  const voiceBits = []
  if (p.rhythm.length) voiceBits.push('节奏：' + p.rhythm.join('；'))
  if (p.sentenceTemplates.length) voiceBits.push('句式：' + p.sentenceTemplates.join('；'))
  if (p.catchphrases.length) voiceBits.push('口头禅：' + p.catchphrases.join('；'))
  if (p.syntax.length) voiceBits.push('句子：' + p.syntax.join('；'))
  if (p.rhetoric.length) voiceBits.push('招式：' + p.rhetoric.join('；'))
  if (voiceBits.length) blocks.push(voiceBits.join('｜'))
  if (p.never.length) blocks.push('他从不：' + p.never.join('；'))
  if (p.identity.length) blocks.push('他是谁（背景）：' + p.identity.join('；'))
  if (p.persona.length) blocks.push('性格：' + p.persona.join('；'))
  if (p.samples.length) blocks.push('他的原话（校准节奏用，绝不照抄内容）：' + p.samples.map((x) => '「' + x + '」').join(' '))
  if (p.style.length) blocks.push('旧特征：' + p.style.join('；') + (p.tone.length ? '｜' + p.tone.join('；') : ''))
  if (p.avoid.length) blocks.push('他不会：' + p.avoid.join('；'))
  return `（群友语感参照「${who}」——在这个群里回话时照着他的接法来，拿不准才回自己的口吻。\n${blocks.join('\n')}\n`
    + `只借说话的方式，不借身份：你不是${who}本人，别自称他、别替他表态。）`
}
