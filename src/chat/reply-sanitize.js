// 出站消息清洗与静默判断：剥离推理/思考残片、<inner> 心智独白、内部备忘、
// 工具协议残片、人设提示词复读及 DSH 中断续跑通知；示例代码与 JSON 字面量受保护豁免。

import { findMemoStart } from './memo-cut.js'

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

/** 推理块的方括号标记：`[Previous reasoning]` / `【思考】` / `[analysis]` 这类。
 * 线上事故 2026-11-22：反代把**上一轮**推理回灌进正文的 text 块，标记写成
 * `[Previous reasoning]…[/Previous reasoning]`——关键词前面多出一个 Previous，
 * 只认紧邻关键词的旧规则一条都匹配不上，整段推理原样发进群。
 * 前缀（previous / prior / 上一轮 / 此前…）可选，中英 + 全角半角括号都认。 */
const REASON_PREFIX = String.raw`(?:previous|prior|last|earlier|above|上\s*一?\s*次|上\s*一?\s*轮|此前|前面)`
const REASON_WORD = String.raw`(?:reasoning|thinking|thought|analysis|思考过程|思考|分析|推理)`
/** 开标记：`[Previous reasoning]`、`【思考】`、`[analysis]`。 */
const REASON_OPEN = String.raw`[[【]\s*(?:` + REASON_PREFIX + String.raw`\s*)?` + REASON_WORD + String.raw`\s*[\]】]`
/** 明确是推理的开标记：带前缀的（`[Previous reasoning]`），或全角「【思考】」这类中文写法。
 *  半角裸 `[分析]` 可能是正常文字（「[分析]这个方案可行」），不在此列。 */
const REASON_OPEN_STRICT = String.raw`(?:[[【]\s*` + REASON_PREFIX + String.raw`\s*` + REASON_WORD + String.raw`\s*[\]】]|【\s*` + REASON_WORD + String.raw`\s*】)`
/** 闭合标记：`[/Previous reasoning]`、`【/思考】`。 */
const REASON_CLOSE = String.raw`[[【]\s*\/\s*(?:` + REASON_PREFIX + String.raw`\s*)?` + REASON_WORD + String.raw`\s*[\]】]`

/** 无标记思考残片的保守清洗（语义移植上游 PR #348）：只删明确的思考标签/括号段、
 * 带元信息的标签行、「最终回答」前的推理开场、「用户说…」推理开头段。
 * 在 sanitizeOutbound 的保护区内调用：围栏代码/行内代码已被 protectExamples 换成占位符，天然豁免。
 * 已知取舍：元信息行启发式按上游保守集合原样移植，「分析：这个方案需要先跑测试。」这类
 * 含元信息关键词的正常行会被上游同样删掉，不自行扩大也不自行收窄。 */
export function stripUnmarkedThinking(text) {
  const raw = String(text || '')
  const found = []
  const add = (start, end) => { if (end > start) found.push({ start, end }) }

  // 【思考】…【/思考】、[Previous reasoning]…[/Previous reasoning] 这类显式块
  for (const m of raw.matchAll(new RegExp(`${REASON_OPEN}[\\s\\S]*?${REASON_CLOSE}`, 'gi'))) add(m.index, m.index + m[0].length)

  // 只有开头没闭合的推理块（截断 / 网关吞掉后半截）：从开标记一路删到结尾。
  // 只在整段开头命中「明确的推理标记」时触发，避免正文里正常出现的
  // 「[分析]这个方案可行」被当成未闭合推理整段吞掉。
  const headOpen = new RegExp(`^\\s*${REASON_OPEN_STRICT}`, 'i').exec(raw)
  if (headOpen && !found.some(({ start, end }) => headOpen.index >= start && headOpen.index < end)) add(headOpen.index, raw.length)
  else {
    // 落单的推理标记（成对块被拆成两半、或代理吞掉了半截）：只删标记本身，不动正文。
    // 只认「明确的推理开标记」和「闭合标记」——它们不可能是正常文字。
    const stray = new RegExp(`${REASON_OPEN_STRICT}|${REASON_CLOSE}`, 'gi')
    for (const m of raw.matchAll(stray)) {
      if (found.some(({ start, end }) => m.index >= start && m.index < end)) continue
      add(m.index, m.index + m[0].length)
    }
  }

  // （思考：…）/（分析：…）这类括号内心段
  for (const m of raw.matchAll(/[（(]\s*(?:思考|分析|推理|内心活动)\s*[：:][\s\S]{0,2000}?[）)]/g)) add(m.index, m.index + m[0].length)

  // 单独成行的「思考过程：/分析：…」；只在带元信息时删，避免误伤正常回答里的“分析：这个方案…”
  for (const m of raw.matchAll(/(^|\n)([ \t]*(?:\*\*)?(?:思考过程|分析过程|推理过程|思考|分析|推理|内心活动|内心|思路|回复策略|回答策略|意图分析|用户意图)\s*[：:][^\n]*)(?=\n|$)/g)) {
    const line = m[2]
    if (/(?:用户|对方|她|他|我|需要|先|然后|回复|回答|意图|情绪|场景|判断|想)/.test(line)) add(m.index + m[1].length, m.index + m[0].length)
  }

  // 结构化推理开场 + 「最终回答：」：只保留最终回答，前面有明确元信息才触发
  const final = /(?:^|\n)[ \t]*(?:最终回答|最终回复|最终答复|回复用户|答复)\s*[：:][ \t]*/i.exec(raw)
  if (final && final.index > 0) {
    const prefix = raw.slice(0, final.index)
    if (/(?:用户|对方|提问者|需要|让我|首先|接下来|分析|判断|回复|回答)/.test(prefix)) add(0, final.index + final[0].length)
  }

  // 「用户说…」+ 空行 + 正文：把纯推理开场段落去掉
  const meta = /^\s*(?:用户|对方|提问者)(?:说|问|想|希望|要求)[\s\S]{0,300}?(?:。|！|？)\s*\n\s*\n/.exec(raw)
  if (meta) add(0, meta[0].length)

  if (!found.length) return raw
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  for (const { start, end } of found) {
    if (end <= cursor) continue
    if (start >= cursor) out += raw.slice(cursor, start)
    cursor = end
  }
  return out + raw.slice(cursor)
}

/**
 * 心智独白的解析预算（计划书 v3.4 §4.3「150 Token 预算兜底」）。
 * 超过这个字数的 inner 块视为「模型跑飞的损坏内心流」：整块丢弃、正文照常输出。
 *
 * 注（2026-11-27）：提示词里教模型写 <inner> 的整段协议已于 #258 移除，所以正常情况下
 * 不会再收到独白。这里保留**剥离**能力是防御性的 —— 老会话历史、模型惯性、以及
 * 入站伪造标签都可能让 <inner> 出现在出站文本里，剥掉才不会把标签发进 QQ。
 * 但 `parseInnerMeta` / `normalizeClosure`（把独白解析成【意图】【闭环】等结构化字段）
 * 的消费者（挂起线索账本 inner-thread-link）已在同一 PR 删除，因此这块解析逻辑一并精简。
 */
export const MAX_INNER_CHARS = 500

/** 在 s[i] 处识别开/闭合/自闭合的 inner 标签：容忍属性、大小写，以及流式输出被掐断的半截标签。 */
function innerTagAt(s, i) {
  if (s[i] !== '<') return null
  const head = /^<(\/?)inner(?![A-Za-z0-9_-])/i.exec(s.slice(i))
  if (!head) return null
  // 找配对的 `>`：跳过引号属性值里的 `>`，否则 `<inner a="x>y"/>` 会被截成开标签并吞掉后续正文。
  // 已知行为：引号不闭合（`<inner a="x` 后直接断流）按「从这里到结尾都没闭合」处理，fail-closed 吞到结尾。
  let j = i + head[0].length
  let quote = ''
  while (j < s.length) {
    const ch = s[j]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') break
    j += 1
  }
  if (j >= s.length) {
    // 后面没有 `>`：闭合标签只吃掉标签自己，开标签按「从这里到结尾都没闭合」处理
    return head[1] === '/' ? { end: j, close: true } : { end: s.length, close: false }
  }
  const end = j + 1
  const attrs = s.slice(i + head[0].length, j)
  // 斜杠在标签名前才是闭合标签；斜杠落在属性段尾部（`<inner/>`、`<inner />`）的是自闭合空标签：
  // 它没有内容，也绝不许把后面的正文当成独白一路吞到结尾（否则出站正文被静默截断）。
  if (head[1] === '/') return { end, close: true }
  if (/\/\s*$/.test(attrs)) return { end, empty: true }
  return { end, close: false }
}

/**
 * 双向解析并 100% 剥离心智独白标签 <inner>…</inner>。
 *
 * 只做**剥离**（这是安全需求，不能删）：
 * - 标签在开头 / 中间 / 多段都支持；多层嵌套按深度配对，外层整段剥离；
 * - 没有闭合的独白（模型输出被截断）从开标签一路剥到结尾，绝不漏半个字进正文；
 * - 破损拼接（例如 <inn<inner>er>）里的假标签碎片一并清掉，残片不能和真标签拼成正常文字；
 * - 只拿走 inner 块本身：||| 分条与 <voice>/<sticker:>/<face>/<report>/<poke> 协议标记原样保留；
 * - 超长块（> MAX_INNER_CHARS，按 code point 数）整块丢弃。
 *
 * 结构化字段（intent/closure/emotion/memo/carried）已随挂起线索账本在 #258 一起移除 ——
 * 那些字段的唯一消费者是 inner-thread-link，它已不存在。这里只返回 `{ text, inner: { raw, overBudget, blocks } }`，
 * 供排障与「超预算丢整块」这一条语义使用。
 *
 * @param {string} text 模型这一轮的原始输出
 * @returns {{text: string, inner: {raw: string, overBudget: boolean, blocks: number}}}
 */
export function extractAndStripInnerMonologue(text) {
  const source = String(text ?? '')
  const kept = []
  const blocks = []
  let i = 0
  let depth = 0
  let start = -1
  while (i < source.length) {
    if (source[i] === '<') {
      const tag = innerTagAt(source, i)
      // 自闭合空标签 `<inner/>`：只跳过标签自己，不进入 depth、不吞后续正文。
      // 已知行为：出现在独白内部（`<inner>A<inner/>B</inner>`）时同样按空标签忽略，不提前收线。
      if (tag && tag.empty) {
        i = tag.end
        continue
      }
      if (tag && tag.close) {
        if (depth > 0) {
          depth -= 1
          if (depth === 0) blocks.push(source.slice(start, i))
        }
        i = tag.end
        continue
      }
      if (tag) {
        if (depth === 0) start = tag.end
        depth += 1
        i = tag.end
        continue
      }
      // 破损尖括号碎片（<inn<inner>er> 这类拼接攻击）：只吃掉「像标签名却接不上 >」的碎片，
      // 正常文本里的 <（比如 3<5）一律放行，不碰。
      const nextLt = source.indexOf('<', i + 1)
      const nextGt = source.indexOf('>', i + 1)
      if (nextLt > i && nextGt > nextLt && /^<\/?[A-Za-z]+$/.test(source.slice(i, nextLt))) {
        i = nextLt
        continue
      }
    }
    if (depth === 0) kept.push(source[i])
    i += 1
  }
  if (depth > 0 && start >= 0) blocks.push(source.slice(start))
  // 嵌套的内层标签在独白原文里也去掉，raw 只留「想的事」
  const raws = blocks.map((b) => b.replace(/<\/?inner(?![A-Za-z0-9_-])[^>]*>?/gi, '').trim())
  // 按 code point 计数：emoji 不能被算成两个字，超预算的块整块丢弃
  const overBudget = raws.some((b) => Array.from(b).length > MAX_INNER_CHARS)
  return {
    text: kept.join('').trim(),
    inner: {
      raw: overBudget ? '' : raws.join('\n').trim(),
      overBudget,
      blocks: blocks.length,
    },
  }
}

/**
 * 等长遮蔽已闭合的 `<inner>…</inner>` 区间，避免直接调用 `stripInternalMemo(raw)` 时
 * 命中 `<inner>` 里的 `【意图】`/`【闭环】`/`【备忘】` 并把后面的正文一起切掉
 * （线上事故 2026-11-25 08:00/12:32：purpose.cleanReply 直接传原文导致整条正文被截成 `"<inner>"`）。
 * 未闭合的 `<inner>` 不遮蔽，仍按泄漏处理。
 */
function maskClosedInner(text) {
  if (!/<inner/i.test(text)) return text
  const spans = []
  let i = 0
  let depth = 0
  let blockStart = -1
  while (i < text.length) {
    if (text[i] === '<') {
      const tag = innerTagAt(text, i)
      if (tag && tag.empty) { i = tag.end; continue }
      if (tag && tag.close) {
        if (depth > 0) {
          depth -= 1
          if (depth === 0 && blockStart >= 0) {
            spans.push([blockStart, tag.end])
            blockStart = -1
          }
        }
        i = tag.end
        continue
      }
      if (tag) {
        if (depth === 0) blockStart = i
        depth += 1
        i = tag.end
        continue
      }
    }
    i += 1
  }
  if (!spans.length) return text
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + '\uE002'.repeat(end - start)
    cursor = end
  }
  return out + text.slice(cursor)
}

/**
 * purpose / 心智独白的结构化内部备忘只供状态机消费，不能进入 QQ 或 bot 聊天流水。
 *
 * 两种形态都要认，缺一个就会漏发（线上事故 2026-11-23，私聊连发两条只有六个字的「【内部备忘】」）：
 * ① **小标题行**：purpose 提示词要求「发完在回合最后另起一段写『内部备忘』」，模型常把它当一条独立
 *    气泡输出（前面还带 `|||`）或写成无冒号裸行 `内部备忘\n【目的】…`。只按下面的标签截断时，截断点是
 *    第一个标签（`【目的】`），小标题就会留在正文尾巴上单独发给主人。
 * ② **行首标签**：没有小标题时按 `【目的】【需求】…` 兜底；至少命中两个才截断——单个标签可能只是正常
 *    行文（「她问：【目的】是什么意思？」），误删比漏发更烦人。
 */
export function stripInternalMemo(text) {
  const s = String(text ?? '')
  // 切分口径由 ./memo-cut.js 统一维护，与网页显示层 inner-fold.js 共用，避免双端漂移。
  const cut = findMemoStart(maskClosedInner(s))
  return cut < 0 ? s : s.slice(0, cut)
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
    // 人设卡第一行不认死某个名字：换卡后复读的是新卡的第一行，也要能认出来。
    // 「真实存在的人 + 不是 AI/助手/机器人」这半句是人设卡的固定写法，名字部分放开；
    // 同时保留对旧版「大肥鱼」硬编码提示词的兼容捕获。
    /你是[^\n，,]{1,24}，一个真实存在的人，正在用手机 QQ 和对面聊天[^\n]*(?:不是 ?AI|不是助手)[^\n]*/i,
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
  const fullPersona = matches.find((match) => /^你是/.test(match[0]))
  if (matches.length < 2 && !fullPersona) return text
  const cut = Math.min(...matches.map((match) => match.index))
  return text.slice(0, cut)
}

/**
 * DSH 的「中断续跑」通知：客户端在流被掐断后会把这一句当成**用户消息**塞回会话
 * （`⚠ The stream was interrupted. Please continue the task you were working on.`），
 * 模型有时候照着念一遍，于是它进了正文、被当气泡发出去 —— 真机 2026-11-24 08:54:56，
 * 群里收到的第一条就是这个（`deliveries.json` 里内容只有这行字）。
 *
 * 只在**同一行同时**出现「stream … interrupted」和「continue the task」时才丢：
 * 正常聊天里说一句「刚被中断了」不会被误杀；代码块里的示例由 protectExamples 保护。
 */
const INTERRUPT_NOTICE_LINE = /^[ \t]*(?:⚠\uFE0F?[ \t]*)?(?:the[ \t]+)?stream[ \t]+(?:was[ \t]+|got[ \t]+)?interrupted\b[^\n]*?continue[ \t]+the[ \t]+task[^\n]*$/i

/** 丢掉续跑通知整行；整段只有这一行就返回空串（等于这一轮无话可说）。 */
export function stripInterruptNotice(text) {
  const s = String(text ?? '')
  if (!/stream\s+(?:was\s+|got\s+)?interrupted/i.test(s)) return s
  const lines = s.split('\n')
  const kept = lines.filter((line) => !INTERRUPT_NOTICE_LINE.test(line))
  return kept.length === lines.length ? s : kept.join('\n').trim()
}

/** 去掉出站中的工具协议残片和被复读的人设提示词；示例代码不参与检测。 */
export function sanitizeOutbound(text) {
  const protectedText = protectExamples(text)
  const protectedJson = protectJsonExamples(protectedText.text)
  // 心智独白（v3.4 Phase 1）：<inner>…</inner> 只给状态机消费，绝不能混进 QQ。
  // 管线顺序按计划书：stripReasoning → stripUnmarkedThinking → extractAndStripInnerMonologue
  // → stripInterruptNotice → stripInternalMemo → stripPromptEcho。
  const stripped = extractAndStripInnerMonologue(stripUnmarkedThinking(stripReasoning(protectedJson.text))).text
  const cleaned = stripInternalMemo(stripInterruptNotice(stripped))
  const sanitized = stripPromptEcho(stripToolOutput(cleaned))
  return protectedText.restore(protectedJson.restore(sanitized))
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}
