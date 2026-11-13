// 顺承前情 → 挂起线索闭环的「解析 + 调度」层（US-020，Phase 1/2）。
//
// 设计边界：
//  - 本模块不认识真实的 thread-ledger（那一层是 US-004），只通过注入的 ledger 接口调用：
//      ledger.peek(chatKey, { includeDormant })  -> 线索数组（每项含 id / keyword? / state?）
//      ledger.resolve(chatKey, id)               -> 闭环（仅在模型明确顺承时调用）
//      ledger.advance(chatKey, id, nextState)?   -> 拓扑推进 active→extended→dormant
//  - 纯函数优先、零 I/O；非法输入 fail-closed（不闭环、不推进、不抛）。
//  - 只有 <inner> 里出现 `【顺承前情】洗澡` 这类标记，系统核对命中线索后，才允许 resolve。
//    用户换话题时（没有标记）线索绝不能被自动 resolved。
import { THREAD_STATES, nextThreadState } from './thread-states.js'

export const CONTINUATION_MARKER = '【顺承前情】'

/**
 * inner 元数据预算（计划书：超过 500 字符整块丢弃并强制 no-close）。
 *
 * 已知行为（US-020 复审第 4 项，**刻意不改**）：正文总长超 500 时，连 `【顺承前情】` 后面
 * 写的那 40 个关键词也一起被丢弃 —— 于是正常顺承同样被拦下。这是 fail-closed 方向的偏差：
 * 宁可少闭环一条线索、让它沿 active→extended→dormant 沉淀，也绝不在超预算时凭半截正文
 * 乱闭环。真实后果只是「线索晚一轮沉淀」，不是误闭环。
 */
export const MAX_INNER_CHARS = 500

const MAX_MARKERS = 12
const MAX_TOKEN_CHARS = 40
const MARKER_RE = /【\s*顺承前情\s*】/g
const NO_CLOSE_SIGNALS = new Set(['continue', 'hold', 'none', 'keep'])
// 全文扫描用：**不做「命中即返回」**，而是把所有出现的 close 类信号收集起来。
// 顺序与写法都不参与判定（`closure: continue` / `closure：continue` / `【闭环】continue` 等价）。
const CLOSURE_SCAN_PATTERNS = [
  /【\s*闭环\s*】\s*[:：]?\s*["']?(close|continue|hold|none|keep)\b/gi,
  /closure\s*["']?\s*[:：=]\s*["']?(close|continue|hold|none|keep)\b/gi,
]
const TRAILING_PUNCT = /[。.!！?？~～、,，;；:：]+$/u
const TOKEN_SEPARATORS = /[\s、,，;；/|+＋&]+/u
const STRIP_PUNCT = /[\s\p{P}\p{S}]/gu

/** 归一化关键词：大小写/空白/标点不参与比较。非字符串一律空串（fail-closed）。 */
export function normalizeThreadKeyword(value) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).toLowerCase().replace(STRIP_PUNCT, '').slice(0, MAX_TOKEN_CHARS)
}

/**
 * 解析 `<inner>` 里的 `【顺承前情】洗澡` 标记。
 * @param {unknown} innerText
 * @returns {string[]} 命中的线索关键词列表（去重、保序、每次都是全新数组）
 */
export function parseThreadContinuation(innerText) {
  if (typeof innerText !== 'string' || innerText.length === 0) return []
  // 超预算 / 损坏的 inner：整块不可信，一律不放行闭环。
  if (innerText.length > MAX_INNER_CHARS) return []

  const found = []
  const seen = new Set()
  const re = new RegExp(MARKER_RE.source, 'g')
  let match = re.exec(innerText)
  while (match !== null) {
    // 一条标记只吃本站行、到下一个标签为止，避免把后续正文/`</inner>` 误当关键词。
    const rest = innerText.slice(match.index + match[0].length)
    const line = rest.split('\n')[0].split('【')[0].split('<')[0]
    for (const raw of line.split(TOKEN_SEPARATORS)) {
      const token = raw.trim().replace(TRAILING_PUNCT, '').slice(0, MAX_TOKEN_CHARS).trim()
      if (!token) continue
      const key = normalizeThreadKeyword(token)
      if (!key || seen.has(key)) continue
      seen.add(key)
      found.push(token)
      if (found.length >= MAX_MARKERS) return found
    }
    match = re.exec(innerText)
  }
  return found
}

/**
 * 解析 `<inner>` 里的闭环信号。返回 'close' | 'continue' | 'hold' | 'none' | 'keep' | null。
 * 超长 inner 触发 Fail-Safe：强制 no-close。
 */
export function parseInnerClosure(innerText) {
  if (typeof innerText !== 'string' || innerText.length === 0) return null
  if (innerText.length > MAX_INNER_CHARS) return 'continue'

  // 先扫全文、后判优先级：**只要出现任何 no-close 信号就整条强制 no-close**。
  // 曾经的「按 CLOSURE_PATTERNS 顺序命中即返回」让 `closure: continue 【闭环】close`
  // 被 【闭环】先吃掉而放行 resolve —— closure:"continue" 是硬红线，顺序/格式都不能绕过。
  let closeSignal = null
  for (const pattern of CLOSURE_SCAN_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match = re.exec(innerText)
    while (match !== null) {
      const signal = match[1].toLowerCase()
      if (isNoCloseSignal(signal)) return signal
      if (closeSignal === null) closeSignal = signal
      match = re.exec(innerText)
    }
  }
  return closeSignal
}

export function isNoCloseSignal(closure) {
  if (closure === null || closure === undefined) return false
  if (typeof closure !== 'string') return false
  return NO_CLOSE_SIGNALS.has(closure.toLowerCase())
}

function threadIdOf(thread) {
  if (!thread || typeof thread !== 'object') return null
  const id = thread.id ?? thread.threadId ?? thread.key
  if (typeof id === 'string' && id.trim()) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return null
}

function threadStateOf(thread) {
  const state = thread && (thread.state ?? thread.status)
  return typeof state === 'string' && THREAD_STATES.includes(state) ? state : 'active'
}

/**
 * 是否已经闭环（终态）。
 *
 * 历史实现是 `!THREAD_STATES.includes(threadStateOf(thread))`，但 threadStateOf 对任何
 * 未知值都兜底成 'active'（fail-closed 的读侧兜底），该表达式因此**永不成立**——死分支。
 * 这里改成显式判定闭环标志与账本终态 `'resolved'`（US-004 thread-ledger.js 是四态，
 * 比本模块的三态拓扑多一个终态 resolved），既可读又可测，语义也不依赖拓扑表。
 */
function isClosed(thread) {
  if (!thread || typeof thread !== 'object') return true
  if (thread.resolved === true || thread.closed === true) return true
  return thread.state === 'resolved' || thread.status === 'resolved'
}

function threadKeywords(thread) {
  if (!thread || typeof thread !== 'object') return []
  // summary 排第二：US-004 真账本里线索正文就叫 summary，缺了它就永远匹配不上（漏闭环）。
  const raw = [
    thread.keyword,
    thread.summary,
    thread.topic,
    thread.label,
    thread.title,
    thread.id,
    thread.threadId,
    thread.key,
  ]
  const out = []
  for (const item of raw) {
    const key = normalizeThreadKeyword(item)
    if (key) out.push(key)
  }
  return out
}

function keywordHits(marker, thread) {
  const m = normalizeThreadKeyword(marker)
  if (!m) return false
  for (const key of threadKeywords(thread)) {
    if (key === m) return true
    // 线索关键词「洗澡/洗漱」，标记只写「洗澡」——允许收录方向单向包含，避免宽松反查。
    if (m.length >= 2 && key.includes(m)) return true
  }
  return false
}

/**
 * 薄适配层：把 US-004 的**真** thread-ledger（`src/chat/thread-ledger.js`）包成本模块契约。
 *
 * 两套形状的差异（实测注入真账本时 `reason:'no-thread'`、拓扑一格未推的根因）：
 *   真账本：peek(chatKey, opts) -> 单条对象 | null；resolve(id, {})；advance(chatKey, {didContinue})
 *           记录字段是 status（四态含 resolved），可见性靠 includeExtended / includeDormant 开关
 *   本模块：peek -> 数组；resolve(chatKey, id, meta)；advance(chatKey, id, nextState)
 *
 * 选「加适配层」而不是「改本模块契约」：模块的数组契约已被 19 条既有测试锁死，
 * 改契约等于把回归网一起拆掉；适配层只加不改，既有多态 fake 账本原样可用。
 *
 * extended 必须可见：隐藏 extended 的账本永远推不到 dormant（拓扑卡在第一个格子）。
 * 真账本用 `list({status:['active','extended']})` 表达可见性；只有 peek 可用时
 * 显式传 `includeExtended: true` 兜底。
 *
 * @param {{peek:Function, resolve:Function, advance?:Function, list?:Function, get?:Function}} ledger
 * @returns {{peek:Function, resolve:Function, advance?:Function}|null} 认不出来返回 null（fail-closed）
 */
export function adaptThreadLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') return null
  if (typeof ledger.peek !== 'function' || typeof ledger.resolve !== 'function') return null
  const canAdvance = typeof ledger.advance === 'function'
  return {
    peek(chatKey, opts = {}) {
      const includeDormant = opts && opts.includeDormant === true
      if (typeof ledger.list === 'function') {
        const rows = ledger.list({ chatKey, status: includeDormant ? 'unresolved' : ['active', 'extended'] })
        return Array.isArray(rows) ? rows.slice() : []
      }
      const one = ledger.peek(chatKey, { includeExtended: true, includeDormant })
      return one ? [one] : []
    },
    resolve(chatKey, id, meta) {
      const by = meta && typeof meta.source === 'string' ? meta.source : CONTINUATION_MARKER
      return ledger.resolve(id, { by })
    },
    ...(canAdvance
      ? {
          advance(chatKey, id, nextState) {
            // 真账本只有「整轮推进」入口：一次 advance(chatKey, {didContinue:false}) 让该会话
            // 所有活线索各推一格，语义等价于本模块逐条 advance 一格。get(id) 做幂等闸门，
            // 避免同一次判定里为多条线索重复推格（over-advance）。
            if (typeof ledger.get === 'function') {
              const rec = ledger.get(id)
              if (!rec) return { ok: false }
              if (rec.status === nextState) return { ok: true, already: true }
            }
            return ledger.advance(chatKey, { didContinue: false })
          },
        }
      : {}),
  }
}

function safePeek(ledger, chatKey) {
  try {
    const threads = ledger.peek(chatKey, { includeDormant: false })
    return Array.isArray(threads) ? threads : []
  } catch {
    return []
  }
}

/**
 * 依据 `<inner>` 决定这条线索引到哪一步。
 * @param {{ peek: Function, resolve: Function, advance?: Function }} ledger 注入的账本接口
 * @param {string} chatKey 会话键
 * @param {unknown} innerText 模型的内心独白原文
 */
export function applyThreadContinuation(ledger, chatKey, innerText) {
  const result = {
    chatKey: typeof chatKey === 'string' ? chatKey : '',
    closure: parseInnerClosure(innerText),
    markers: [],
    resolved: [],
    advanced: [],
    skipped: [],
    blocked: false,
    reason: 'ok',
  }

  // no-close 保护信号优先级最高：任何 resolve 都必须被拦下，连拓扑都不动。
  if (isNoCloseSignal(result.closure)) {
    result.blocked = true
    result.reason = 'closure-continue'
    return result
  }
  if (!result.chatKey || !ledger || typeof ledger.peek !== 'function' || typeof ledger.resolve !== 'function') {
    result.reason = 'invalid-input'
    return result
  }

  result.markers = parseThreadContinuation(innerText)
  const threads = safePeek(ledger, chatKey)
  if (threads.length === 0) {
    result.reason = 'no-thread'
    return result
  }

  const seen = new Set()
  for (const thread of threads) {
    const id = threadIdOf(thread)
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (isClosed(thread)) {
      result.skipped.push({ id, reason: 'already-closed' })
      continue
    }

    const hit = result.markers.find((marker) => keywordHits(marker, thread))
    if (hit) {
      result.resolved.push(id)
      try {
        ledger.resolve(chatKey, id, { keyword: hit, source: CONTINUATION_MARKER })
      } catch {
        // 账本自己炸了不算我们的错，但对外仍 fail-closed：当作没闭环。
        result.resolved.pop()
        result.skipped.push({ id, reason: 'resolve-failed' })
      }
      continue
    }

    // 未顺承：绝不 resolved，只按 v3.4 拓扑往后挪一格。
    const from = threadStateOf(thread)
    const to = nextThreadState(from)
    if (!to || to === from) {
      result.advanced.push({ id, from, to, applied: false })
      continue
    }
    if (typeof ledger.advance !== 'function') {
      result.advanced.push({ id, from, to, applied: false, reason: 'no-advance' })
      continue
    }
    try {
      ledger.advance(chatKey, id, to)
      result.advanced.push({ id, from, to, applied: true })
    } catch {
      result.advanced.push({ id, from, to, applied: false, reason: 'advance-failed' })
    }
  }

  if (result.markers.length === 0) result.reason = 'no-marker'
  return result
}
