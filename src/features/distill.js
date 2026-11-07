// 蒸馏群友 v2（评分制蒸馏架构，2026-11-07 重构）：
// 「指定某个群里的人当数据源，学他怎么说话」这条链路的彻底重做。
//
// 与 v1（1.3.59~1.3.65）的区别：
//   v1：一次模型调用产出全部字段 → 字符串去重合并 → 无限追加 → 无衰减 → 双渲染源。
//   v2：三段流水线（Extract 提取 → Verify 校验 → Reflect 反思），
//       每条特征带证据引用 + 置信分 + 时间戳，合并走「评分制生存」而不是字符串拼接，
//       渲染收敛成单一出口 renderProfile()。
//
// 蒸馏学习点（业界依据，2026-11-07 查证）：
//   · arXiv 2410.03848：ToT（多候选对比择优）> 单次生成；原话样本进提示词是主信号。
//     → Verify 阶段逐条打分就是 ToT 的轻量落地：不重写全文，只判「哪条活下来」。
//   · Generative Agents（arXiv 2304.03442）：reflection 生成高阶综合；recency 衰减。
//     → Reflect 阶段 + 衰减淘汰（FRESH_DAYS）。
//   · 作者身份验证研究（2024-2025 综述）：光靠提示词模仿复现不出作者个体性，逐字原话必须保留。
//     → 证据引用是硬约束：Extract 产出的每条必须带原文短引用，否则丢弃。
//   · StyleRemix（ACL 2025）：风格拆成可解释、可独立评估的元素。
//   · SillyTavern 角色卡工程：mes_example（示例对话）是教「怎么接话」的最强手段；
//     personality 写可观察行为，不写空形容词。
//
// 一条硬边界（写进注入文本，也写进提示词）：**学的是说话的样子，不是冒充这个人**。
// 她在群里用相似的语感、句长、口头禅，但绝不声称自己是对方、也不替对方表态。

// 各字段条数上限（沿用 v1，测试契约锁定）
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

// v2 评分制参数
export const SCORE = {
  NEW: 0.7, // Extract+Verify 双确认的新条目初始分
  DROP_BELOW: 0.3, // 低于此分淘汰
  FRESH_DAYS: 30, // lastSeen 超过这么多天且分低 → 淘汰（recency 衰减）
  VERIFY_KEEP: 0.55, // Verify 给分 ≥ 此值才保留
  CONFIRM_BONUS: 0.2, // 再次被证据确认（同义复现）加的分，封顶 1.0
  CONFLICT_PENALTY: 0.3, // Verify 判冲突 → 低分自然淘汰（常量供提示词/面板引用）
}
const FIELDS = ['exchanges', 'syntax', 'catchphrases', 'rhetoric', 'never', 'persona', 'style', 'tone', 'samples', 'avoid']

// 纯转发的卡片/图片/链接不是「他本人在说话」，喂给模型只会稀释证据
const JUNK_RE = /^\[(分享卡片|图片|动画表情|表情包|视频|文件)[^\]]*\]\s*$|^https?:\/\/\S+\s*$/

/** 从这个群的流水里挑出目标那个人说的话：滤掉纯转发、去重、按时间正序。 */
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

// dedupConvo 挪到了 chat/fish-guard.js（防刷屏工具归防刷屏模块），这里 re-export 保持既有调用方
export { dedupConvo } from '../chat/fish-guard.js'

// ---------------- v2 画像数据模型 ----------------

/**
 * 归一一条特征为 v2 结构 { text, evidence, score, firstSeen, lastSeen }。
 * 兼容三种输入：字符串 / {text,...} v2 条目 / 非法值（丢弃）。
 */
export function normEntry (v, { now = Date.now() } = {}) {
  if (v == null) return null
  const text = typeof v === 'string' ? v.trim().slice(0, 200) : String(v.text || '').trim().slice(0, 200)
  if (!text || /^\d+$/.test(text)) return null
  const t = Number(v.t) || now
  return {
    text,
    evidence: typeof v === 'object' && Array.isArray(v.evidence) ? v.evidence.slice(0, 3).map((e) => String(e).slice(0, 120)).filter(Boolean) : [],
    score: typeof v === 'object' && Number.isFinite(Number(v.score)) ? Math.min(1, Math.max(0, Number(v.score))) : 0.6,
    firstSeen: typeof v === 'object' && Number(v.firstSeen) ? Number(v.firstSeen) : t,
    lastSeen: typeof v === 'object' && Number(v.lastSeen) ? Number(v.lastSeen) : t,
  }
}

const normList = (v, cap, opt) => {
  const list = Array.isArray(v) ? v : v ? [v] : []
  const seen = new Set()
  const out = []
  for (const x of list) {
    const e = normEntry(x, opt)
    if (!e || seen.has(e.text)) continue
    seen.add(e.text)
    out.push(e)
    if (out.length >= cap) break
  }
  return out
}

/** 画像归一：全字段过 normEntry。纯字符串数组（v1）自动升级为 v2 条目。 */
export function normalizeProfile (obj, opt = { now: Date.now() }) {
  const out = {}
  for (const f of FIELDS) out[f] = normList(obj && obj[f], FIELD_CAP[f], opt)
  return out
}

/** 面板/日志用的字符串化视图：v2 条目数组 → text 数组（兼容旧消费方）。 */
export function profileToTexts (profile) {
  const p = normalizeProfile(profile || {})
  const out = {}
  for (const f of FIELDS) out[f] = p[f].map((e) => e.text)
  return out
}

/**
 * 语义近似判定（本地、零成本）：字符 2-gram Jaccard。
 * 「斩（随口催办时）」 vs 「喜欢说斩（催办时）」 → 相近；完全不同的两条 → 不相近。
 */
export function isSimilar (a, b) {
  const s = (x) => String(x || '').replace(/\s+/g, '')
  const x = s(a); const y = s(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length < 4 || y.length < 4) return x.includes(y) || y.includes(x)
  const grams = (t, n = 2) => {
    const g = new Set()
    for (let i = 0; i <= t.length - n; i++) g.add(t.slice(i, i + n))
    return g
  }
  const gx = grams(x); const gy = grams(y)
  let inter = 0
  for (const g of gx) if (gy.has(g)) inter++
  return inter / (gx.size + gy.size - inter) >= 0.55
}

/**
 * 评分制合并（v2 核心）：旧画像 × 新证据 → 幸存者列表。
 * 规则：
 *   · 新条目与旧条目语义近似 → 复现确认：旧条目加分、lastSeen 刷新、补证据；新条目不重复入列。
 *   · 新条目 score < VERIFY_KEEP（Verify 判死）→ 不入列。
 *   · 旧条目太久没复现（> FRESH_DAYS）且分低 → 衰减淘汰。
 *   · 排序按 score 降序（谁可信谁在前），超上限截断。
 */
export function mergeProfile (old, incoming, opt = {}) {
  const now = opt.now || Date.now()
  const verified = opt.verified !== false
  const a = normalizeProfile(old || {}, { now })
  const b = normalizeProfile(incoming || {}, { now })
  const out = {}
  for (const f of FIELDS) {
    const olds = a[f].map((e) => ({ ...e }))
    for (const ne of b[f]) {
      if (verified && ne.score < SCORE.VERIFY_KEEP) continue
      const hit = olds.find((oe) => isSimilar(oe.text, ne.text))
      if (hit) {
        hit.score = Math.round(Math.min(1, hit.score + SCORE.CONFIRM_BONUS) * 100) / 100
        hit.lastSeen = Math.max(hit.lastSeen, ne.lastSeen || now)
        hit.firstSeen = Math.min(hit.firstSeen, ne.firstSeen || now)
        if (!hit.evidence.length && ne.evidence.length) hit.evidence = ne.evidence.slice(0, 3)
        continue
      }
      olds.push({ ...ne, score: verified ? Math.max(ne.score, SCORE.NEW) : ne.score })
    }
    const survivors = olds.filter((e) => {
      const staleDays = (now - (e.lastSeen || now)) / 86400000
      return !(staleDays > SCORE.FRESH_DAYS && e.score < 0.6) && e.score >= SCORE.DROP_BELOW
    })
    survivors.sort((x, y) => y.score - x.score)
    out[f] = survivors.slice(0, FIELD_CAP[f])
  }
  return out
}

/** 找旧画像里某字段的全部条目文本（供 Verify 提示词对照）。 */
export function oldTextsOf (old, field) {
  return profileToTexts(old || {})[field] || []
}

// ---------------- v2 三段流水线提示词 ----------------

const WHO_MAX = 20
const saidLines = (lines, n = 120, cut = 160) => (lines || []).slice(-n).map((x) => `他：${String(x.text).slice(0, cut)}`).join('\n')

/**
 * ① Extract 提取提示词：只做「找证据」——每条特征必须附上他本人的原文短引用。
 */
export function buildExtractPrompt ({ name = '这个人', uid = '', memberLines = [], context = [], others = [] } = {}) {
  const who = String(name || '这个人').slice(0, WHO_MAX)
  const want = String(uid || '')
  const isHim = (x) => want && String((x && x.uid) || '') === want
  const convoLines = (context || []).slice(-160).map((x) => {
    if (typeof x === 'string') return x
    const text = String(x.text || '').slice(0, 120)
    return isHim(x) ? `他：${text}` : `${x.name || ''}：${text}`
  })
  const convo = convoLines.join('\n')
  const contrast = (others || []).slice(-20).map((x) => String(x).slice(0, 100)).join('\n')
  return {
    system: [
      '你是语言风格分析师。给你一个人在 QQ 群里的原话和群聊原文，把「他怎么说话」拆成可执行的模仿特征。',
      '输出 JSON 对象：{"exchanges":[{"text":"...","evidence":["原文短引用"]},...],"syntax":[...],"catchphrases":[...],"rhetoric":[...],"never":[...],"persona":[...]}',
      '',
      '每个字段是对象数组，每条两个键：',
      '  text：特征描述（exchanges 的 text 是完整对话对，格式"问：\u201c对方的话\u201d\n答：\u201c他的原话（逐字）\u201d"）',
      '  evidence：1~3 条支撑这条特征的**他的原话短引用**（逐字摘，每条不超过 40 字）',
      '',
      '字段含义：',
      'exchanges（最重要）：2~3 组一问一答——别人问/说什么、他怎么接。要能看出接话方式（先 @ 谁、语气词、答多长）。',
      'syntax：句子长短怎么搭、断句习惯（逗号串/空格/换行）、开头习惯（先 @ 人？先喊兄弟们？）。每条 ≤25 字。',
      'catchphrases：口头禅，格式 `词/句式（什么时候用）`。',
      'rhetoric：反复用的表达套路（自嘲、玩梗、反问……），每条带例子。',
      'never：他从不用的词（如感谢/请问/抱歉）、从不做的行为。',
      'persona：2~4 条**可观察行为**（如「被封号就自嘲」），不许写「他很友善」这种换成谁都成立的话。',
      '',
      '四条硬规矩：',
      '1) 每条 text 必须附 evidence，evidence 必须逐字来自上面给的原话/原文——没有依据的条目不要输出；',
      '2) 自检：换成群里另一个人也成立的条目删掉；',
      '3) 证据不足的字段给空数组，不要编；',
      '4) 只输出 JSON 对象，正文别加分析。',
    ].join('\n'),
    text: `要学的人：${who}\n\n他的原话：\n${saidLines(memberLines)}\n\n`
      + (convo ? `群聊原文（他的回答标了「他：」）：\n${convo}\n\n` : '')
      + (contrast ? `群里别人说的话（对照用，不要学这些）：\n${contrast}\n\n` : '')
      + '只输出 JSON 对象。',
  }
}

// v1 API 兼容：老调用方（memory.js 与既有测试）还在用 buildDistillPrompt。
// v2 里它 = Extract 提示词（同样的入参契约），返回结构一致 { system, text }。
export const buildDistillPrompt = buildExtractPrompt

/**
 * ② Verify 校验提示词（裁判视角，独立一次调用）：
 * 与 Extract 分离是 v1 最大的补丁——v1 让提取者自查，形同虚设。
 */
export function buildVerifyPrompt ({ name = '这个人', memberLines = [], extracted = {}, old = null, baseBody = '' } = {}) {
  const who = String(name || '这个人').slice(0, WHO_MAX)
  const quotes = (memberLines || []).slice(-80).map((x) => `他：${String(x.text).slice(0, 120)}`).join('\n')
  const oldParts = []
  if (old) {
    const t = profileToTexts(old)
    for (const f of ['exchanges', 'syntax', 'catchphrases', 'rhetoric', 'never', 'persona']) {
      if (t[f].length) oldParts.push(`${f}：${t[f].join('；')}`)
    }
  }
  return {
    system: [
      '你是严格的审核员。下面是对一个人说话风格的「特征候选」，每条带证据引用。',
      '逐条审核，输出 JSON：{"verdicts":[{"text":"原样抄回来的特征文本","keep":true/false,"score":0~1,"reason":"一句话"}]}',
      '打分标准（score）：',
      '  1.0：证据引用真实支撑、且是这个人的鲜明个性（别人没有的）；',
      '  0.7：证据支撑，但比较普通；',
      '  0.4：证据撑不起来（引用对不上或太弱）；',
      '  0.2：换成群里任何人都成立（套话）；',
      '  0.1：和旧画像直接冲突且新证据不足；',
      '  0.1：duplicate——她的人设卡正文里已经覆盖（不用再学）。',
      'keep = score ≥ 0.55。拿不准时从严（给低分）——错误特征混进人设的代价远大于漏掉一条。',
      '只输出 JSON 对象。',
    ].join('\n'),
    text: `要学的人：${who}\n\n他的原话（核对 evidence 用）：\n${quotes || '（无）'}\n`
      + `\n特征候选：\n${JSON.stringify(extracted, null, 1).slice(0, 6000)}\n`
      + (oldParts.length ? `\n旧画像（参考，判「是否在说同一件事/是否冲突」）：\n${oldParts.join('\n')}\n` : '')
      + (baseBody ? `\n她的人设卡正文（判「这条是否已被覆盖」，覆盖了标 duplicate 低分）：\n${String(baseBody).slice(0, 800)}\n` : '')
      + '\n只输出 JSON 对象。',
  }
}

/**
 * ③ Reflect 反思提示词（低频触发，如每 5 次学习一次）：
 * Generative Agents 的 reflection——把多条低层特征综合成高阶锚点。
 */
export function buildReflectPrompt ({ name = '这个人', profile = {} } = {}) {
  const who = String(name || '这个人').slice(0, WHO_MAX)
  const cur = profileToTexts(profile)
  return {
    system: [
      '你是人物分析师。下面是对一个人说话风格的逐条特征记录（已经过验证）。',
      '把它们综合出 1~3 条**更高一层的概括**（比如「骂人不带脏字，用反问代替攻击」这类跨条目的模式）。',
      '输出 JSON：{"reflections":["..."]}',
      '规矩：概括必须能被下面已有条目共同支撑，不引入新设定；显而易见的就不用再概括；拿不出就给空数组。',
      '只输出 JSON 对象。',
    ].join('\n'),
    text: `人物：${who}\n\n已有特征：\n${['exchanges', 'syntax', 'catchphrases', 'rhetoric', 'never', 'persona'].filter((f) => cur[f].length).map((f) => `${f}：${cur[f].join('；')}`).join('\n') || '（无）'}\n\n只输出 JSON 对象。`,
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
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Extract 回包 → 带 evidence 的 v2 条目。
 * 硬约束：没有 evidence 的条目直接丢弃（exchanges 除外——它本身就是逐字引用形态）。
 */
export function parseExtracted (raw, { now = Date.now() } = {}) {
  const obj = typeof raw === 'string' ? parseDistillProfile(raw) : raw
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '回包解析失败' }
  const out = {}
  let total = 0
  for (const f of FIELDS) {
    const list = (Array.isArray(obj[f]) ? obj[f] : obj[f] ? [obj[f]] : []).map((x) => {
      if (x && typeof x === 'object' && x.text != null) return { text: x.text, evidence: x.evidence, t: now }
      return x
    })
    out[f] = normList(list, FIELD_CAP[f], { now }).filter((e) => f === 'exchanges' || e.evidence.length > 0)
    total += out[f].length
  }
  if (!total) return { ok: false, reason: '模型判空画像，或全部条目缺证据引用', fields: out }
  return { ok: true, fields: out }
}

/**
 * Verify 回包 → 把裁判的分数写回 Extract 条目。
 * 裁判漏判的条目从严给 0.4（不过线，弃权即淘汰）。
 */
export function applyVerdicts (extracted, raw) {
  const obj = typeof raw === 'string' ? parseDistillProfile(raw) : raw
  const list = (obj && Array.isArray(obj.verdicts)) ? obj.verdicts : []
  const byText = new Map()
  for (const v of list) {
    const t = String((v && v.text) || '').trim()
    if (t) byText.set(t, v)
  }
  const out = {}
  let total = 0
  for (const f of FIELDS) {
    out[f] = (extracted[f] || []).map((e) => {
      const v = byText.get(e.text)
      const score = v && Number.isFinite(Number(v.score)) ? Math.min(1, Math.max(0, Number(v.score))) : 0.4
      return { ...e, score }
    }).filter((e) => e.score >= SCORE.VERIFY_KEEP)
    total += out[f].length
  }
  if (!total) return { ok: false, reason: '校验后全部淘汰', fields: out }
  return { ok: true, fields: out }
}

/** Reflect 回包 → 反思条目（进 persona 字段，双确认分）。 */
export function parseReflections (raw, { now = Date.now() } = {}) {
  const obj = typeof raw === 'string' ? parseDistillProfile(raw) : raw
  const list = (obj && Array.isArray(obj.reflections)) ? obj.reflections : []
  return normList(list.map((x) => ({ text: x, score: SCORE.NEW, t: now })), 3, { now })
}

// ---------------- 渲染（v2 唯一出口） ----------------

/**
 * v2 唯一渲染出口：画像 → 注入文本。
 * mode='hint'：当轮小抄（第三人称「他」）；mode='card'：人设卡借用段（第一人称「我」）。
 * 兼容 v1 字符串数组画像（normalizeProfile 自动升级）。
 * @returns {string} 空字符串表示没学到东西
 */
export function renderProfile (profile, { mode = 'hint', name = '这个人' } = {}) {
  const p = normalizeProfile(profile || {})
  const has = p.exchanges.length || p.syntax.length || p.catchphrases.length || p.persona.length || p.samples.length || p.style.length
  if (!has) return ''
  const who = String(name || '这个人').slice(0, WHO_MAX)
  const blocks = []
  const card = mode === 'card'
  if (p.exchanges.length) {
    blocks.push((card ? '我在这个群接话就照着他的应对方式来（学应对方式，聊天内容绝不照搬）：' : '他怎么接话（学的是应对方式，内容绝不照搬）：')
      + '\n' + p.exchanges.map((e) => '- ' + e.text).join('\n'))
  }
  const voice = []
  if (p.catchphrases.length) voice.push('口头禅：' + p.catchphrases.map((e) => e.text).join('；'))
  if (p.syntax.length) voice.push((card ? '句子架构：' : '句子：') + p.syntax.map((e) => e.text).join('；'))
  if (p.rhetoric.length) voice.push((card ? '修辞招式：' : '招式：') + p.rhetoric.map((e) => e.text).join('；'))
  if (voice.length) blocks.push(voice.join('\n'))
  if (p.never.length) blocks.push((card ? '我不用他绝不会用的东西：' : '他从不：') + p.never.map((e) => e.text).join('；'))
  if (p.persona.length) blocks.push((card ? '我借他神韵的地方：' : '他是这样的人：') + p.persona.map((e) => e.text).join('；'))
  if (p.samples.length) blocks.push('他的原话（校准节奏用，' + (card ? '不引用' : '绝不照抄内容') + '）：' + p.samples.map((e) => '「' + e.text + '」').join(' '))
  if (p.style.length) blocks.push('旧特征：' + p.style.map((e) => e.text).join('；') + (p.tone.length ? '｜' + p.tone.map((e) => e.text).join('；') : ''))
  if (p.avoid.length) blocks.push('他不会：' + p.avoid.map((e) => e.text).join('；'))
  if (card) {
    return `【语感·借自「${who}」】\n${blocks.join('\n')}\n（只借说话方式，不借身份：我不是${who}，不自称他、不替他表态、不提他个人隐私。）`
  }
  return `（群友语感参照「${who}」——在这个群里回话时照着他的接法来，拿不准才回自己的口吻。\n${blocks.join('\n')}\n`
    + `只借说话的方式，不借身份：你不是${who}本人，别自称他、别替他表态。）`
}

// v1 API 兼容：老调用方还在用这个名字
export const renderDistillHint = (name, profile) => renderProfile(profile, { mode: 'hint', name })
