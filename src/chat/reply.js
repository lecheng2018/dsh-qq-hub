// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。

export const SILENCE = '[沉默]'

/** 去掉 Markdown 痕迹，转换为 QQ 友好的清晰排版。 */
export function stripMarkdown(text) {
  let s = String(text || '')
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
  const raw = String(text || '').trim()
  if (isSilence(raw)) return { silent: true, items: [] }
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
  if (items.length === 0) return { silent: true, items: [] }
  return { silent: false, items: capBubbles(items) }
}

const MAX_BUBBLES = 5

/** 文字气泡最多 5 条，多出来的并进最后一条（防止刷屏）。 */
function capBubbles(items) {
  const texts = items.filter((i) => i.kind === 'text')
  if (texts.length <= MAX_BUBBLES) return items
  const keep = new Set(texts.slice(0, MAX_BUBBLES - 1))
  const tail = texts.slice(MAX_BUBBLES - 1)
  const merged = { kind: 'text', value: tail.map((t) => t.value).join('\n') }
  const out = []
  let placed = false
  for (const it of items) {
    if (it.kind !== 'text' || keep.has(it)) out.push(it)
    else if (!placed) { out.push(merged); placed = true }
  }
  return out
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
  const cap = Math.max(10, Math.round(Number(rules.maxChars) || 30))
  // 她自己在哪断句（换行 / |||）就按她的断法发：字数只当兜底，不当尺子。
  // 老行为（直接调 parseReply 不带规则）保持按字数硬拆，工具与测试不受影响。
  const trust = rules.trustModelBubbles === true
  const hard = Math.max(cap * 2, 60)
  // 清单/汇报（多段小标题、编号列表、代码块）：整段发。这类内容拆开就散了。
  // 代码块的围栏会被 stripMarkdown 去掉，所以要在原文上判一次。
  const blockish = String(s || '').includes('```') || looksLikeReport(t)
  if (rules.keepReports !== false && t.length <= 1200 && blockish) {
    items.push({ kind: 'text', value: t })
    return
  }
  for (const line of splitLines(t)) {
    if (trust && line.length <= hard) { items.push({ kind: 'text', value: line }); continue }
    for (const piece of splitLongLine(line, cap)) if (!isSilence(piece)) items.push({ kind: 'text', value: piece })
  }
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
  const pick = (v, def, min, max) => Math.round(Math.min(max, Math.max(min, Number(v) || def)))
  return {
    maxChars: inGroup ? pick(r.groupMaxChars, 40, 10, 500) : pick(r.privateMaxChars, 120, 20, 2000),
    trustModelBubbles: r.trustModelBubbles !== false,
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
