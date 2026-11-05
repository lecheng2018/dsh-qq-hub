// 让模型自己决定在哪断开（抄 MaiMBot 的做法）。
//
// 规则分条有两个它永远处理不好的情况：
//   1. 一整段没有句末标点，全是「词 词 词」堆起来的汇报，规则只能整条发；
//   2. 长文排版（一行一个要点），规则要么全拆要么全不拆，都不是人说话的样子。
// 这种情况多花一次模型调用，让它按语义挑断点，比猜规则准。
//
// 三条纪律（比 MaiMBot 更保守）：
//   · 只准移动断点，不准改字。返回结果去掉空白后必须和原文一模一样，否则整条丢弃。
//   · 模型说不用拆（no_split）就照规则发，不硬拆。
//   · 任何异常（超时、返回不是 JSON、校验不过）都退回规则分条，绝不影响发消息。

const SPLIT_PROMPT = `把下面这条消息按自然语义断开，改成几条适合逐条发送的短消息。
规则：
1. 只返回 JSON 字符串数组，例如 ["第一句。","第二句？"]，不要 Markdown、不要解释。
2. 只能在原文已有的字符之间切开，不许改写、增删、换顺序、改标点。
3. 括号、引号、颜文字、代码不要从中间拆开。
4. 条数尽量 2 到 3 条，最多 {max} 条。短句不要单独拆。
5. 指标罗列、逐行要点、带【小标题】的排版内容，整段读着才清楚，返回 no_split。
6. 如果本来就短、或者完整一段读着更顺（代码、公式、清单），只返回 no_split。

原文：
`

/** 排版型内容：小标题（【…】）、逐行罗列的指标。这类东西拆开就是一堆碎片，只能整段发。 */
export function looksStructured(text) {
  const t = String(text || '')
  const heads = t.match(/【[^】]{1,14}】/g)
  if (heads && heads.length >= 2) return true
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
  if (lines.length < 3) return false
  const short = lines.filter((x) => x.length <= 18).length
  const numeric = lines.filter((x) => /[%％]|\d/.test(x)).length
  return short * 2 >= lines.length && numeric * 2 >= lines.length && t.length >= 60
}

/** 去掉全部空白，用于校验「只动断点、不动字」。 */
export function squash(text) {
  return String(text || '').replace(/\s+/g, '')
}

/** 解析模型返回：容忍 ```json 围栏、裸 no_split、以及被包成 JSON 字符串的 no_split。 */
export function parseSplitPayload(raw) {
  let t = String(raw == null ? '' : raw).trim()
  if (!t) return { ok: false, reason: 'empty' }
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const bare = t.replace(/^"|"$/g, '').trim().toLowerCase()
  if (bare === 'no_split' || bare === '"no_split"') return { ok: true, noSplit: true, segments: [] }
  // 模型偶尔在数组外面写一句话，取第一个 [...] 块
  if (!t.startsWith('[')) {
    const start = t.indexOf('[')
    const end = t.lastIndexOf(']')
    if (start >= 0 && end > start) t = t.slice(start, end + 1)
  }
  try {
    const arr = JSON.parse(t)
    if (!Array.isArray(arr)) return { ok: false, reason: 'not-array' }
    const segments = arr.map((x) => (typeof x === 'string' ? x : '')).filter((x) => x.trim())
    if (segments.length < 2) return { ok: false, reason: 'too-few' }
    return { ok: true, segments }
  } catch (error) {
    return { ok: false, reason: 'bad-json' }
  }
}

/**
 * 校验并归一：拼接后必须与原文一致（忽略空白），否则判定模型改了字，整条丢弃。
 * @returns {string[]|null}
 */
export function acceptSplit(original, segments, { maxSegments = 6 } = {}) {
  if (!Array.isArray(segments) || segments.length < 2) return null
  if (squash(segments.join('')) !== squash(original)) return null
  const list = segments.map((s) => String(s).trim()).filter(Boolean)
  if (list.length < 2) return null
  if (list.length <= maxSegments) return list
  // 条数太多：按顺序均匀合并，别把剩下的全塞进最后一条
  const out = []
  let start = 0
  for (let g = 0; g < maxSegments; g += 1) {
    const remain = list.length - start
    const left = maxSegments - g
    const size = Math.ceil(remain / left)
    out.push(list.slice(start, start + size).join(''))
    start += size
  }
  return out
}

/**
 * 需要模型出马吗：只有「规则分条只得到一条，而且这条还挺长」才值得多花一次调用。
 * 正常聊天（几条短句）永远不会走这里。
 */
export function worthLlmSplit(text, ruleBubbles, { minChars = 80, maxChars = 600, enabled = true } = {}) {
  if (!enabled) return false
  const t = String(text || '')
  if (t.length < minChars || t.length > maxChars) return false
  if (looksStructured(t)) return false // 排版型：整段发，拆开就碎了
  if (t.includes('```')) return false
  if (Array.isArray(ruleBubbles) && ruleBubbles.length > 1) return false
  return true
}

/**
 * 问模型要断点。失败一律返回 null（调用方按规则发），不抛异常。
 * @param {string} text 原文
 * @param {{ask: Function, maxSegments?: number, log?: any, timeoutMs?: number}} o
 * @returns {Promise<string[]|null>}
 */
export async function llmSplit(text, { ask, maxSegments = 6, log } = {}) {
  const body = String(text || '').trim()
  if (!body || typeof ask !== 'function') return null
  let raw = ''
  try {
    raw = await ask({
      system: '你只做一件事：给一段话挑断句位置。只输出 JSON 字符串数组或 no_split。',
      text: SPLIT_PROMPT.replace('{max}', String(maxSegments)) + body,
      maxTokens: Math.min(1200, 200 + body.length * 2),
      temperature: 0,
    })
  } catch (error) {
    log?.debug?.('断句失败，按规则发：', error.message || error)
    return null
  }
  const parsed = parseSplitPayload(raw)
  if (!parsed.ok) {
    log?.debug?.('断句结果看不懂，按规则发：', parsed.reason)
    return null
  }
  if (parsed.noSplit) return null
  const accepted = acceptSplit(body, parsed.segments, { maxSegments })
  if (!accepted) log?.debug?.('断句改了原文，丢弃，按规则发')
  return accepted
}
