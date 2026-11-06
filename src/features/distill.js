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

const FIELD_CAP = {
  style: 6, // 说话方式：句长、标点、口头禅、语气词、表情和 @ 习惯、回复节奏
  persona: 6, // 性格：脾气、幽默方式、在意什么、对熟人和生人的差别
  tone: 4, // 语气：对不同场合/不同人的态度倾向
  samples: 5, // 逐字原话（主信号：模仿语感靠它，不靠形容词）
  avoid: 3, // 负向：他从不做的事（防止被通用聊天腔带跑）
}

/** 从这个群当天的流水里挑出目标那个人说的话（按时间正序）。 */
export function collectMemberLines (lines, uid) {
  const want = String(uid || '').trim()
  if (!want) return []
  return (lines || [])
    .filter((l) => l && l.text && String(l.uid || '') === want && !String(l.text).startsWith('【系统'))
    .map((l) => ({ t: Number(l.t) || 0, text: String(l.text) }))
    .sort((a, b) => a.t - b.t)
}

/** 话太少就不值得花一次模型调用（学出来也是瞎猜）。门槛 20 句对齐 molroo 的 20~30 条建议。 */
export function enoughEvidence (memberLines, { minMessages = 20, minChars = 120 } = {}) {
  const list = memberLines || []
  if (list.length < minMessages) return false
  return list.reduce((n, x) => n + x.text.length, 0) >= minChars
}

/** 拼提炼提示词：给他本人的原话（带上下文中的别人一句，帮助判断他在回应什么）。 */
export function buildDistillPrompt ({ name = '这个人', memberLines = [], context = [], others = [], old = null } = {}) {
  const who = String(name || '这个人').slice(0, 20)
  const said = (memberLines || []).slice(-120).map((x) => `他：${x.text.slice(0, 160)}`).join('\n')
  const around = (context || []).slice(-40).join('\n')
  // 对照：群里别人的话。靠「他和别人不一样在哪」定位他的特征（molroo 的 otherMessages 思路）
  const contrast = (others || []).slice(-20).map((x) => String(x).slice(0, 100)).join('\n')
  const oldText = old
    ? `\n已有的旧画像（新证据里仍成立的保留、被推翻的丢掉，合并成一份，别越写越多）：\n`
      + `说话方式：${(old.style || []).join('；') || '（无）'}\n`
      + `性格：${(old.persona || []).join('；') || '（无）'}\n`
      + `语气：${(old.tone || []).join('；') || '（无）'}\n`
    : ''
  return {
    system: [
      '你是语言风格分析师。给你一个人在 QQ 群里的发言（必要时附上群里别人的话做对照），',
      '你要提炼出「照着模仿他说话」需要知道的全部信息。输出 JSON 对象：',
      '{"samples":[...],"style":[...],"persona":[...],"tone":[...],"avoid":[...]}',
      '',
      'samples（最重要）：**逐字摘** 3~5 条最能代表他的原话，一条不超过 40 字。',
      '  要挑能听出是他的那种——带他的口头禅、他的标点习惯、他的语气；',
      '  不要挑「今天天气不错」这种谁都会说的话；不要改写、不要加标点、不要补全，原样抄。',
      'style（说话方式）：句子长短、标点习惯（爱不爱用标点/省略号/感叹号/空格断句）、',
      '  口头禅和常用词、语气词、表情与 @ 的用法、一次发几条。要写到他这个人，不是这个群。',
      'persona（性格）：脾气、幽默方式、在意什么、对熟人和生人的差别、爱不爱较真。',
      'tone（语气）：对不同场合/不同人的态度倾向。',
      'avoid（他从不做的）：2~3 条。比如他从不长篇解释、从不问「在吗」、从不用「感谢」。',
      '  这是防止模仿时被通用聊天腔带跑的关键。',
      '',
      '三条硬规矩：',
      '1) **自检**：每条描述在心里换成群里任何另一个人试一遍——如果换成谁都成立，就删掉，别写。',
      '2) 每条描述必须能在他上面某句原话里找到依据；找不到依据的不要写。',
      '3) 每条不超过 25 字，写成人话。证据不足的类别给空数组，不要编。',
    ].join('\n'),
    text: `要学的人：${who}\n\n他的原话：\n${said}\n\n`
      + (contrast ? `群里别人说的话（用来对照出他跟别人的不同，不要学这些）：\n${contrast}\n\n` : '')
      + (around ? `（同期群聊上下文，帮助判断他在回应什么）：\n${around}\n\n` : '')
      + oldText
      + '只输出 JSON 对象。',
  }
}

/** 解析模型回包：容忍 ```json 围栏、外面带解释。 */
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

/** 收成固定三类，去空、去重、截长度和条数。 */
export function normalizeProfile (obj) {
  const pick = (v, cap) => {
    const list = Array.isArray(v) ? v : v ? [v] : []
    const seen = new Set()
    const out = []
    for (const x of list) {
      const s = String(x == null ? '' : x).trim().slice(0, 60)
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
      if (out.length >= cap) break
    }
    return out
  }
  return {
    style: pick(obj && obj.style, FIELD_CAP.style),
    persona: pick(obj && obj.persona, FIELD_CAP.persona),
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
    style: merge(a.style, b.style, cap.style),
    persona: merge(a.persona, b.persona, cap.persona),
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
  if (!p.style.length && !p.persona.length && !p.tone.length && !p.samples.length) return ''
  const who = String(name || '这个人').slice(0, 20)
  const blocks = []
  // 原话优先：模仿语感靠具体句子，不靠形容词（arXiv 2410.03848 的核心发现）
  if (p.samples.length) blocks.push('他的原话（照这个语感说，别照抄内容）：\n' + p.samples.map((x) => '- 「' + x + '」').join('\n'))
  const parts = []
  if (p.style.length) parts.push('说话方式：' + p.style.join('；'))
  if (p.persona.length) parts.push('性格：' + p.persona.join('；'))
  if (p.tone.length) parts.push('语气：' + p.tone.join('；'))
  if (parts.length) blocks.push('特征：' + parts.join('｜'))
  if (p.avoid.length) blocks.push('他不会：' + p.avoid.join('；'))
  return `（你在向群里的「${who}」学说话的样子。\n${blocks.join('\n')}\n`
    + `可以顺着这个语感聊，但你不是${who}、也不能替${who}表态，别自称他、别冒用他的身份。）`
}
