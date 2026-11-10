// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//   - `<report>…</report>` 包住的内容是「数据报告」：只洗 Markdown、整段发出，不按聊天分条
//     （1.3.48。忘了写标记但这一轮调过内容型工具时，hub 会兜底整段发，见 CONTENT_TOOLS）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。

export const SILENCE = '[沉默]'

/** 去掉模型思考标签（<think>、<thought>、<reasoning> 等及其孤立闭合标签）。 */
export function stripReasoning(text) {
  let s = String(text || '')
  // 1. 成对闭合的思考块：整段连同标签全部移除
  s = s.replace(/<(think|thought|reasoning|reflection|antThinking)(\s+[^>]*)?>[\s\S]*?<\/\1>/gi, '')
  // 2. 只有开头没闭合的整段思考（例如模型思考到一半被截断）
  s = s.replace(/^<(think|thought|reasoning|reflection|antThinking)(\s+[^>]*)?>[\s\S]*$/gi, '')
  // 3. 孤立的闭合或开启标签（如模型被代理或网关吞噬前缀后漏出的 </thought>、</think>）
  s = s.replace(/<\/?(think|thought|reasoning|reflection|antThinking)(\s+[^>]*)?>/gi, '')
  return s
}

/** purpose 的结构化内部备忘只供状态机消费，不能进入 QQ 或 bot 聊天流水。 */
export function stripInternalMemo(text) {
  const s = String(text ?? '')
  const labels = /(^|\n)\s*[【\[]\s*(目的|需求|情绪|类型|状态|待续)\s*[】\]]/g
  const first = labels.exec(s)
  if (!first) return s
  const second = labels.exec(s)
  return second ? s.slice(0, first.index) : s
}

function protectExamples(text) {
  const examples = []
  const placeholder = (value) => {
    const token = `\uE000${examples.length}\uE001`
    examples.push(value)
    return token
  }
  const s = String(text ?? '').replace(/```[\s\S]*?```|```[\s\S]*$/g, placeholder).replace(/`[^`\n]+`/g, placeholder)
  return { text: s, restore: (value) => value.replace(/\uE000(\d+)\uE001/g, (_, i) => examples[Number(i)] ?? '') }
}

function protectJsonExamples(text) {
  const examples = []
  const stack = []
  let out = ''
  let cursor = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (start < 0) {
      if (ch !== '{' && ch !== '[') continue
      start = i
      stack.push(ch)
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) {
        stack.length = 0
        start = -1
        continue
      }
      if (stack.length === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          const value = JSON.parse(candidate)
          if (value && typeof value === 'object') {
            const token = `\uE100${examples.length}\uE101`
            examples.push(candidate)
            out += text.slice(cursor, start) + token
            cursor = i + 1
          }
        } catch {}
        start = -1
      }
    }
  }
  if (cursor > 0) text = out + text.slice(cursor)
  return { text, restore: (value) => value.replace(/\uE100(\d+)\uE101/g, (_, i) => examples[Number(i)] ?? '') }
}

function stripToolOutput(text) {
  let s = text.replace(/<(?:\|DSML\||｜DSML｜)function_calls\s*>[\s\S]*?(?:<(?:\|DSML\||｜DSML｜)\/function_calls\s*>|<\/(?:\|DSML\||｜DSML｜)function_calls\s*>)/gi, '')
  s = s.replace(/<(?:\|DSML\||｜DSML｜)invoke\b[^>]*>[\s\S]*?(?:<(?:\|DSML\||｜DSML｜)\/invoke\s*>|<\/(?:\|DSML\||｜DSML｜)invoke\s*>)/gi, '')
  const openDsml = /<(?:\|DSML\||｜DSML｜)[^>]*>/i.exec(s)
  if (openDsml) s = s.slice(0, openDsml.index)
  s = s.replace(/<\|(python|browser|qq_[a-z0-9_.-]+|[a-z0-9_.-]*tool[a-z0-9_.-]*)\|>[\s\S]*?(?:<\|im_end\|>|$)/gi, '')
  s = s.replace(/<\|im_start\|>([\s\S]*?)(?:<\|im_end\|>|<\|fim_suffix\|>|$)/gi, (message) => {
    const sep = message.indexOf('<|im_sep|>')
    if (sep < 0) return ''
    const header = message.slice('<|im_start|>'.length, sep).trim()
    if (!/^assistant(?:\s|<|$)/i.test(header) || /\bto=\S+/i.test(header)) return ''
    const channel = header.match(/<\|(?:meta_sep|meta_start)\|>(\S+)/i)?.[1]?.toLowerCase()
    if (channel && channel !== 'final') return ''
    return message.slice(sep + '<|im_sep|>'.length).replace(/<\|(?:im_end|fim_suffix)\|>$/i, '')
  })
  const route = /(?:^|\s)(?:assistant\s+to=|<\|(?:tool_call|call)\|>)[^\n]*/i.exec(s)
  if (route) s = s.slice(0, route.index)
  s = s.replace(/<(tool_call|function_call|tool_calls)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
  return s.replace(/<\/?(?:\|DSML\||｜DSML｜)[^>]*>|<\|(?:im_start|im_sep|im_end|fim_suffix|ghissue|ghreview|meta_sep|meta_start|meta_end|tool_call|call|python|browser)\|>/gi, '')
}

function stripPromptEcho(text) {
  const markers = [
    /你是大肥鱼，一个真实存在的人，正在用手机 QQ 和对面聊天。不是 AI，不是助手，不是机器人/i,
    /【你现在在 QQ 上】/,
    /【怎么说话：像人在打字】/,
    /【打字习惯】/,
    /【最重要的一条】/,
    /【绝对禁止】/,
    /【你的样子】/,
    /【最后自检】/,
    /【什么时候别说话：潜水规则】/,
    /- 你的整段回复会被直接发到 QQ/,
    /- 每条用户消息开头会标明来源/,
  ]
  const matches = markers.map((marker) => marker.exec(text)).filter(Boolean)
  const fullPersona = matches.find((match) => match[0].startsWith('你是大肥鱼'))
  if (matches.length < 2 && !fullPersona) return text
  const cut = Math.min(...matches.map((match) => match.index))
  return text.slice(0, cut)
}

/** 去掉出站中的工具协议残片和被复读的人设提示词；示例代码不参与检测。 */
function sanitizeOutbound(text) {
  const protectedText = protectExamples(text)
  const protectedJson = protectJsonExamples(protectedText.text)
  const cleaned = stripInternalMemo(stripReasoning(protectedJson.text))
  const sanitized = stripPromptEcho(stripToolOutput(cleaned))
  return protectedText.restore(protectedJson.restore(sanitized))
}

/** 去掉 Markdown 痕迹，转换为 QQ 友好的清晰排版。 */
export function stripMarkdown(text) {
  let s = stripReasoning(text)
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
  s = s.replace(/`([^`\n]+)`/g, '$1')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')

  // 破折号硬拦（主人要求禁用 ——）：提示词禁令实测压不住（群友示范+styles 强化会把它顶回来），
  // 所以在发送出口直接替换。破折号常见两种用法：
  //   A——B（解释/转折）→ 逗号最稳妥，任何语境都通顺
  //   行尾挂 dash 拖音（"反正就这样——"）→ 收尾直接删掉，不留半个符号
  // 先删行尾孤立的（包括后跟空白），再把句中的换成逗号；顺序不能反，否则行尾那个会先被换成逗号。
  s = s.replace(/——+\s*$/gm, '')
  s = s.replace(/——+/g, '，')

  // 核心排版：数字列表项（1. 2. 3. 等）前面如果不是空行，自动补空行，强制撑开呼吸感
  s = s.replace(/([^\n])\r?\n(\d+[.、]\s*)/g, '$1\n\n$2')

  // 分割线转为清晰的 QQ 细分割线
  s = s.replace(/^[*-]{3,}$/gm, '━━━━━━━━━━━━━━')

  s = s.replace(/[ \t]+$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}

/**
 * 解析一轮回复。
 * @param {string} text 模型这一轮的最终正文
 * @returns {{silent: boolean, items: Array<{kind:'text'|'voice'|'sticker'|'image', value:string, replyTo?:string}>}}
 */
export function parseReply(text, rules = {}) {
  let raw = sanitizeOutbound(text).trim()
  if (isSilence(raw)) return { silent: true, items: [] }
  // 报告标记（1.3.48）：<report>…</report> 里的内容是「给主人看的数据」。
  // 摘出来当**一条**整段气泡（在 ||| 拆分之前摘，标记里的空行不能当气泡边界）；
  // 标记外的部分照常走 ||| 分条（开场白归聊天）。模型偶尔忘了闭合：从开标记到结尾都算报告。
  let reportBody = ''
  const reportMatch = raw.match(/<report>([\s\S]*?)<\/report>/) || raw.match(/<report>([^]*)$/)
  if (reportMatch) {
    reportBody = stripMarkdown(reportMatch[1])
    raw = (raw.slice(0, reportMatch.index) + raw.slice(reportMatch.index + reportMatch[0].length)).trim()
    if (isSilence(raw) && isSilence(reportBody)) return { silent: true, items: [] }
  }
  const items = []
  let replyTo = '' // 等着挂到下一条气泡上的「引用回复」编号
  const attach = (from) => {
    if (replyTo && items.length > from) {
      items[from].replyTo = replyTo
      replyTo = ''
    }
  }
  for (const bubble of raw.split('|||')) {
    const part = bubble.trim()
    if (!part) continue
    // 依次切出 reply / voice / sticker / markdown 图片，其余是文字
    const re = /<poke\s*\/?>|<reply:\s*(\d+)\s*>|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g
    let last = 0
    let m
    while ((m = re.exec(part)) !== null) {
      let from = items.length
      pushText(items, part.slice(last, m.index), rules)
      attach(from)
      from = items.length
      if (m[0].startsWith('<poke')) {
        if (!items.some((i) => i.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (m[1] !== undefined) {
        replyTo = m[1]
      } else if (m[2] !== undefined) {
        const v = stripMarkdown(m[2])
        if (v) items.push({ kind: 'voice', value: v })
      } else if (m[3] !== undefined) {
        const v = m[3].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      } else if (m[4] !== undefined) {
        items.push({ kind: 'image', value: m[4] })
      }
      attach(from)
      last = re.lastIndex
    }
    const from = items.length
    pushText(items, part.slice(last), rules)
    attach(from)
  }
  // 一轮最多引用一次，多的去掉（大多数时候正常发就好）
  let quoted = false
  for (const it of items) {
    if (!it.replyTo) continue
    if (quoted) delete it.replyTo
    quoted = true
  }
  if (items.length === 0 && !reportBody) return { silent: true, items: [] }
  const finalItems = capBubbles(items, rules.maxBubbles)
  // 报告气泡放最后（她一般先说一句人话，再给数据），不参与条数上限——数据报告不该被截断
  if (reportBody) finalItems.push({ kind: 'text', value: reportBody })
  return { silent: false, items: finalItems }
}

const MAX_BUBBLES = 6

/**
 * 文字气泡超过上限时，**均匀分组**，不是把剩下的全塞进最后一条。
 * 老做法（tail.join('\n')）会得到「4 条极短 + 1 坨巨块」，线上实测最难看的就是这个
 * （2026-11-05）。均匀分组至少让每条长短接近，读起来像人一条条说。
 */
export function capBubbles(items, max = MAX_BUBBLES) {
  const limit = Math.max(1, Math.round(Number(max) || MAX_BUBBLES))
  const texts = items.filter((i) => i.kind === 'text')
  if (texts.length <= limit) return items
  const groups = []
  let start = 0
  for (let g = 0; g < limit; g += 1) {
    const remain = texts.length - start
    const left = limit - g
    const size = Math.ceil(remain / left)
    groups.push(texts.slice(start, start + size).map((t) => t.value).join('\n'))
    start += size
  }
  // 按顺序把文字项换成合并后的组，媒体项（表情/语音/图片）位置不动
  const out = []
  let gi = 0
  for (const it of items) {
    if (it.kind !== 'text') { out.push(it); continue }
    if (gi < groups.length) { out.push({ ...it, kind: 'text', value: groups[gi] }); gi += 1 }
  }
  return out
}

/**
 * 一轮回复怎么分条。调研过同类项目的做法（AstrBot / MaiMBot，见 docs/回复分条.md）：
 *
 *  - 换行不是消息边界。模型用单换行排版（一行一个要点），当成消息边界发出去就是
 *    「4 条极短 + 1 坨巨块」，线上实测最难看（2026-11-05）。
 *  - 真正的边界只有三个：`|||`（她显式写的）、空行（段落）、句末标点（。！？…；）。
 *  - 太短的不单独成条：攒够「最短条长」才断开。
 *  - 一整段没有任何句末标点时，退一步把单换行当**弱边界**（可用，但不强制），
 *    这样排版型汇报也能切成几条，而不是一坨 200 多字。
 *  - 清单、步骤、代码块、指标汇报整段发，不按行拆。
 *
 * 返回 [{ text, brk }]，brk 是这一片**后面**的边界类型：'punct' | 'nl' | ''
 */
export function segmentUnits(text) {
  const tags = []
  // 标签/URL/时间/小数先占位：它们的冒号、斜杠、点绝不能当断句点
  // （「到14:22」曾被杀成「…到14」「22」；链接从 ? 处断成两截点不开）
  const guarded = String(text || '').replace(
    /\d{1,3}:\d{1,3}(?::\d{1,3})?|\d+\.\d+|<(?:face|sticker|voice|at|reply|poke)[^>]*>|<\/[^>]+>|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi,
    (m) => { tags.push(m); return '~~Z' + (tags.length - 1) + 'Z~~' },
  )
  const units = []
  let buf = ''
  let quote = 0
  const quoteOpen = '“「『\''
  const quoteClose = '”」』\''
  for (let i = 0; i < guarded.length; i += 1) {
    const ch = guarded[i]
    if (quoteOpen.includes(ch)) quote += 1
    else if (quoteClose.includes(ch) && quote > 0) quote -= 1
    if (ch === '\n') {
      // 单换行：不写进正文，只当弱边界候选
      if (buf.trim()) { units.push({ text: buf.trim(), brk: 'nl' }); buf = '' } else buf = ''
      continue
    }
    buf += ch
    const sentenceEnd = '。！？!?…；;'.includes(ch)
    if (!sentenceEnd) continue
    if (quote > 0) continue // 引号里的句号不是句子边界
    const next = guarded[i + 1] || ''
    if ('：:'.includes(next)) continue // 「注意：」后面还有内容
    if (/[0-9]/.test(buf[buf.length - 2] || '') && /[0-9]/.test(next)) continue // 1.5 这类
    units.push({ text: buf.trim(), brk: 'punct' })
    buf = ''
  }
  const rest = buf.trim()
  if (rest) units.push({ text: rest, brk: '' })
  // 换行的性质看整段排版：
  //  · **短行**（≤15 字）随便多少行都是她在分行说话（「a/b/c/d」七个超短行也是）→ hard。
  //  · **中行**（16~30 字）只在行数 ≤3 时算聊天分行 → hard。原阈值只有 15，两句话各 17 字
  //    （「今晚刚见证教程没捂热号先凉，你说呢」正好 17）被误判成排版，soft 边界再按 0.45 概率
  //    合——一半概率把两句不同话题粘成一条带 \n 的消息（2026-11-06 线上实锤）。
  //  · **长行**（>30 字/行）或中行超过 3 行 → 长文排版（指标汇报一类）→ soft，能不拆就不拆。
  const lines0 = guarded.split('\n').map((x) => x.trim()).filter(Boolean)
  const allShort = lines0.length > 1 && lines0.every((x) => x.length <= 15)
  const fewMedium = lines0.length > 1 && lines0.length <= 3 && lines0.every((x) => x.length <= 30)
  for (const u of units) {
    if (u.brk !== 'nl') continue
    u.brk = (allShort || fewMedium) ? 'hard' : 'soft'
  }
  return units.map((u) => ({ ...u, text: u.text.replace(/~~Z(\d+)Z~~/g, (_, i) => tags[Number(i)] || '') }))
}

/**
 * 把句子片攒成气泡：攒够 minBubble 才考虑断开，断不断带随机（真人不是机械切）。
 * 换行边界比句末标点更容易断（0.7 vs 0.4），因为换行本来就是排版意图。
 */
export function mergeUnits(units, { cap, minBubble, rand = Math.random }) {
  const out = []
  let cur = ''
  let brk = ''
  for (const u of units) {
    if (!u.text) continue
    if (!cur) { cur = u.text; brk = u.brk; continue }
    if (brk === 'hard') { out.push(cur); cur = u.text; brk = u.brk; continue }
    const joiner = brk === 'soft' ? '\n' : ''
    const merged = cur + joiner + u.text
    const closeProb = brk === 'soft' ? 0.45 : 0.4
    const long = merged.length > cap
    if (cur.length >= minBubble && (long || rand() < closeProb)) {
      out.push(cur)
      cur = u.text
    } else {
      cur = merged
    }
    brk = u.brk
  }
  if (cur) out.push(cur)
  return out
}

/** 一整轮文字 → 若干气泡（字符串数组）。pushText 用它。 */
/** 真正的「报表」才整段发：两个以上【小标题】，或者一整片短条目的编号清单。
 *  以前只要看到编号列表就整段发，结果她发一段带路径的技术说明，499 字挤成一条巨块，
 *  在 QQ 里像贴文档（2026-11-05 实测）。 */
function structuredReport(t) {
  const heads = t.match(/【[^】]{1,14}】/g)
  if (heads && heads.length >= 2) return true
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
  if (lines.length < 3) return false
  const items = lines.filter((x) => /^(\d+[.、)]|[-*•·])/.test(x)).length
  if (items * 2 < lines.length) return false
  const avg = lines.reduce((n, x) => n + x.length, 0) / lines.length
  return avg <= 40
}

export function segmentBubbles(text, rules = {}) {
  const t = String(text || '').trim()
  if (!t) return []
  const cap = Math.max(10, Math.round(Number(rules.maxChars) || 30))
  const minBubble = Math.max(6, Math.round(cap * (Number(rules.minBubbleRatio) || 0.4)))
  const rand = typeof rules.rand === 'function' ? rules.rand : Math.random
  if (t.includes('```')) return [t]
  // 清单/汇报/指标整段发（拆开对应关系就散了）。判整段，不按段落判，
  // 否则「【结论】…」和下面的编号列表会被切成两条。
  if (rules.keepReports !== false && t.length <= 1200 && structuredReport(t)) return [t]
  // 段落（空行）是硬边界：一段一条，段内再按句子攒
  const paragraphs = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  const bubbles = []
  for (const p of paragraphs) {
    const units = segmentUnits(p)
    for (const b of mergeUnits(units, { cap, minBubble, rand })) {
      // 单片本身远超上限（英文长句、无标点堆栈）：退回按逗号/空格兜底切，绝不留半句
      if (b.length <= cap * 2) { bubbles.push(b); continue }
      for (const piece of splitLongLine(b, cap)) bubbles.push(piece)
    }
  }
  return bubbles.length ? bubbles : [t]
}

/**
 * 一段文字拆成几条气泡：真人打字是一行一条发出去的。
 * 有代码块、或者是长篇内容（比如帮主人查东西的结果）就整段发，不拆。
 */
/** 把一个长气泡按句读硬拆成短条（群友不写长句）。仅在普通聊天路径使用；整段发（代码块/长文）不走这里。 */
function splitLongLine(line, maxChars = 30) {
  const s = String(line || '').trim()
  if (!s || s.length <= maxChars) return s ? [s] : []
  // 标签保护：<face:捂脸> / <sticker:x> / <voice>…</voice> 内部有冒号，
  // 按标点切会把 '<face:' 和 '捂脸>' 拆到两条里（线上真实事故）。
  // URL 同理：https:// 里的冒号和斜杠会被逗号/冒号层切坏（链接点不开）。
  // 占位符用纯文本（绝不用控制字符——会把源文件写成 binary）。
  const tags = []
  const canGuard = !s.includes('~~X')
  // 时间/比例（09:22、到14:22、1:3）里的冒号不是句子边界：以前把「：」「:」当切点，
  // 「今天09:22开的 到14:22」被切成「…到14」「22 已经烧掉55%」，冒号还被抹掉，
  // 线上看着就是莫名其妙被截断（2026-11-05 实测）。和标签、URL 一样先占位保护。
  const guarded = canGuard
    ? s.replace(/\d{1,3}:\d{1,3}(?::\d{1,3})?|<(?:face|sticker|voice|at|reply|poke)[^>]*>|<\/[^>]+>|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi, (m) => {
        tags.push(m)
        return '~~X' + (tags.length - 1) + 'X~~'
      })
    : s
  // ① 只在**句号类**标点处切（。！？；）：这些断了是自然的。
  //    逗号不是句子边界，在逗号处切会把一句话劈成两截
  //    （"Astra 压我一头" / "Code Arena 登顶" / "API 贵 2.5 倍" 那种碎裂感）。
  const parts = sentencePieces(guarded).map((x) => x.trim()).filter(Boolean)
  // ② 单句仍超 hardMax（约两倍）才按逗号切 —— 这种是真长句（并列项、绕弯的长解释）。
  //    hardMax 取 maxChars 的 2 倍：宁可发一条 45 字的长消息，也不要半句话。
  const hardMax = Math.max(maxChars * 2, 40)
  const refined = []
  for (const p of parts) {
    if (p.length <= hardMax) { refined.push(p); continue }
    let buf = ''
    for (const seg of p.split(/(?<=[，,、])/)) {
      if (buf && (buf + seg).length > hardMax) { refined.push(buf); buf = seg }
      else buf += seg
    }
    if (buf) refined.push(buf)
    // 长句被切开的地方要补上句末感：以逗号结尾的改成句号（"…差别没那么大。" 是通顺的），
    // 顿号/冒号/分号结尾的直接去掉（那是并列中途，不该带标点收尾）。
    for (let i = 0; i < refined.length - 1; i += 1) {
      refined[i] = refined[i].replace(/[，,]\s*$/, '。').replace(/[、；;]\s*$/, '')
    }
  }
  // ③ 聚合：只有**很短的片段**才跟前后挤成一条（避免「草」「好」一字一条刷屏）。
  //    完整句子一律单独成条，不硬塞 —— 两句完整的话挤在一条里比分开更像机器人。
  const out = []
  let cur = ''
  const shortLimit = Math.max(6, Math.floor(maxChars / 2))
  for (const p of refined) {
    if (!cur) { cur = p; continue }
    if (cur.length <= shortLimit || p.length <= shortLimit) {
      if ((cur + p).length <= maxChars) { cur += p; continue }
    }
    out.push(cur)
    cur = p
  }
  if (cur) out.push(cur)
  // ④ 还原标签（不删结尾逗号：既然不在逗号处断，就不会有半句）
  return out.map((t) => (canGuard ? t.replace(/~~X(\d+)X~~/g, (_, i) => tags[Number(i)] ?? '') : t))
}
export function splitLines(text) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.includes('```')) return [t]
  // 像列表 / 步骤的多行内容（一大半以数字或符号开头）整段发 —— 每一项都是一个
  // 完整信息块，拆开反而破坏对应关系；后面超长时再按条目分页，不在条目内部截断。
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= 1) {
    // 单行（或单段无换行）：超 240 才按句号兜底切，绝不截半句
    if (t.length <= 240) return [t]
    return listPages([t], t)
  }
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  if (listy >= Math.ceil(lines.length / 2)) return listPages(lines, t)
  // 按语义块拆：优先空行（段落边界），其次单行；一行一行发是真人打字的样子，
  // 但一整句被字符上限拦腰切断不是 —— 上限只在块本身超长时兜底。
  // 注意保留空行信息：先按空行切大段，大段内部再按单行。
  const paragraphs = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  const blocks = []
  for (const p of paragraphs) {
    const pLines = p.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    // 单行段落直接成块；多行段落整块保留（段落是完整语义）
    // 多行段落里如果每行都是短句（≤30 字，真人打字的样子），仍按行一条条发；
    // 只有长行组成的段落才整块保留（段落是完整语义，拆了破坏对应关系）
    if (pLines.length > 1 && pLines.every((l) => l.length <= 30)) {
      for (const l of pLines) blocks.push(l)
    } else blocks.push(pLines.join('\n'))
  }
  const out = []
  for (const b of blocks) {
    // 块不超长就整块发（可以是多行的一条消息）；超长才退回按行拆
    if (b.length <= 240) { out.push(b); continue }
    for (const line of b.split('\n')) {
      if (line.length <= 240) { out.push(line); continue }
      // 单行也超长：按句号兜底切成完整句，不在半句中间截断
      let seg = ''
      for (const piece of sentencePieces(line)) {
        if (seg && (seg + piece).length > 240) { out.push(seg); seg = piece }
        else seg += piece
      }
      if (seg) out.push(seg)
    }
  }
  return out
}

/** 列表内容的分页：以「条目」为单位凑页，每页 ≤240 字，绝不把一条内容切成两半。
 * 普通聊天不需要它（真人消息短），这是给 RSS 摘要 / 检测汇报这类「模型一次吐出
 * 十条福利」的场景用的 —— 以前一刀切会把第 5 条福利拦腰截断。 */
function listPages(lines, full) {
  const pages = []
  let buf = ''
  for (const l of lines) {
    if (l.length > 240) {
      // 单条就超长：按句号切成完整句块单独成页（仍然不在条目内部截断语义句）
      if (buf) { pages.push(buf); buf = '' }
      let seg = ''
      for (const piece of sentencePieces(l)) {
        if (seg && (seg + piece).length > 240) { pages.push(seg); seg = piece }
        else seg += piece
      }
      if (seg) pages.push(seg)
      continue
    }
    if (buf && (buf + '\n' + l).length > 240) { pages.push(buf); buf = l }
    else buf = buf ? buf + '\n' + l : l
  }
  if (buf) pages.push(buf)
  return pages
}

/** 句号兜底切分的公共实现：先按句号类标点切；某段本身还超长（英文长句/URL/无标点堆栈）
 * 再按逗号；连逗号都没有（纯英文一整句）就按空格硬切 —— 撑爆气泡比切开更难看。
 * 之前只有句号一层，英文长句整段原样发出去。
 * URL 不切：空格切分时以 http(s)://、www. 开头的整段 token 原样保留（切开链接就点不开了）。 */
function sentencePieces(line) {
  const out = []
  // URL 先占位再切：句号层正则里的半角 ? 会把链接的查询串切走（"…query?" / "param=1" 分家）。
  const tags = []
  const guarded = String(line || '').replace(/\d{1,3}:\d{1,3}(?::\d{1,3})?|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi, (m) => {
    tags.push(m)
    return '~~Y' + (tags.length - 1) + 'Y~~'
  })
  const isUrlTok = (t) => /^~~Y\d+Y~~$/.test(t.trim())
  for (const piece of guarded.split(/(?<=[。！？!?；;])/)) {
    if (piece.length <= 240) { out.push(piece); continue }
    let buf = ''
    for (const seg of piece.split(/(?<=[，,、])/)) {
      if (seg.length > 240) {
        // 逗号也救不了：按空格硬切（URL/代码串整段放行，切开会坏）
        for (const word of seg.split(/(?<=\s)/)) {
          if (isUrlTok(word)) {
            if (buf) { out.push(buf); buf = '' }
            out.push(word.trim())
            continue
          }
          if (buf && (buf + word).length > 240) { out.push(buf); buf = word }
          else buf += word
        }
        continue
      }
      if (buf && (buf + seg).length > 240) { out.push(buf); buf = seg }
      else buf += seg
    }
    if (buf) out.push(buf)
  }
  // 还原 URL 占位符
  const restored = out.map((p) => p.replace(/~~Y(\d+)Y~~/g, (_, i) => tags[Number(i)] || ''))
  return restored
}

function pushText(items, s, rules = {}) {
  const t = stripMarkdown(String(s || '').replace(/<\/?reply[^>]*>/g, '')) // 写坏的引用标签直接去掉
  if (!t || isSilence(t)) return
  // 报告路径（1.3.48）：<report> 包住的整段内容（含代码块/长文）只洗 Markdown、不切段。
  // 里面的编号列表、空行排版保留 —— 「查一下/拉一下」就该整条排版返回，不是被切成碎片。
  // 注意 stripMarkdown 会给编号列表补空行，那属于显示排版；整段发必须在切段之前决定，
  // 所以这里跳过 segmentBubbles（段落边界对报告没意义），也不再过 capBubbles（报告不打断）。
  if (rules.forceReport) {
    items.push({ kind: 'text', value: t })
    return
  }
  // 清单/汇报（多段小标题、编号列表、代码块）：整段发。这类内容拆开就散了。
  // 代码块的围栏会被 stripMarkdown 去掉，所以要在原文上判一次。
  if (rules.keepReports !== false && String(s || '').includes('```') && t.length <= 1200) {
    items.push({ kind: 'text', value: t })
    return
  }
  for (const piece of segmentBubbles(t, rules)) {
    if (!isSilence(piece)) items.push({ kind: 'text', value: piece })
  }
}

/** 像不像列表：过半的行以 1. / 2、 / - / • 开头。每一项都是一个完整信息块，拆开对应关系就散了。 */
function looksLikeList(t) {
  const lines = String(t || '').split(/\n+/).map((x) => x.trim()).filter(Boolean)
  if (lines.length < 2) return false
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  return listy >= Math.ceil(lines.length / 2)
}

/** 像不像「清单/汇报」：小标题多、编号列表、代码块、或整段都是长行。 */
function looksLikeReport(t) {
  if (t.includes('```')) return true
  if ((t.match(/【[^】]{1,20}】/g) || []).length >= 2) return true
  const lines = t.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  if (lines.length < 4) return false
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  if (listy >= Math.ceil(lines.length / 2)) return true
  const longLines = lines.filter((l) => l.length >= 25).length
  return longLines >= Math.ceil(lines.length * 0.6)
}

/** 面板上的分条规则 → parseReply 的参数。群聊与私聊可以有不同上限。 */
export function replyRules(cfg, inGroup) {
  const r = (cfg && cfg.reply) || {}
  // 注意 0 是合法输入（不能因为 Number(0) 是 falsy 就退回默认值）
  const pick = (v, def, min, max) => {
    const n = Number(v)
    const base = v === '' || v === null || v === undefined || !Number.isFinite(n) ? def : n
    return Math.round(Math.min(max, Math.max(min, base)))
  }
  return {
    maxChars: inGroup ? pick(r.groupMaxChars, 40, 10, 500) : pick(r.privateMaxChars, 120, 20, 2000),
    maxBubbles: pick(r.maxBubbles, 6, 1, 12),
    minBubbleRatio: 0.4,
    keepReports: r.keepReports !== false,
  }
}

/** 对方是不是明确要她发语音（「用语音说」「发个语音」「语音回我」……）。 */
export function wantsVoice(text) {
  const t = String(text || '')
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}

/**
 * 发下一条之前停多久（毫秒）：按「打字速度」算——下一条越长停越久，再加一点随机抖动。
 * @param {string} [next] 下一条要发的内容
 */
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  const len = String(next || '').length
  const typing = 350 + len * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, typing)) * (0.8 + rand() * 0.5))
}
