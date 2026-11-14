// S2 慢思考判定层：让小模型从最近几轮对话里挑出**真正值得挂起**的未闭环线索（US-019）。
//
// 为什么 S1 规则层不够：规则认的是「我去洗澡了」这种显式句式；真实对话里更常见的
// 是「那事儿回头再说」「你先忙你的，等有空聊」——语义上挂着，字面上没有关键词。
// S2 补的就是这一层语义判断。
//
// 三条硬规则：
//   1. **fail-open**：模型报错/超时/返回非法 JSON/拿不到模型，一律返回 `[]`。
//      线索是「锦上添花」的状态，主链路（这一轮回复）绝不能因为判定挂了就发不出去。
//   2. **去幻觉**：模型返回的 summary 必须在原文里找得到语义锚点（归一化后 ≤2 字的
//      汉字/数字片段至少在原文出现），否则丢弃。小模型很爱编「用户说要去看电影」这种原文没有的事。
//   3. **严格 JSON + 有上限**：maxTokens / timeoutMs / 条数都夹死，绝不无限等。

import { askModel } from '../core/llm.js'
import { THREAD_TYPES } from './thread-ledger.js'
import { normalizeThreadSummaryText } from './thread-producer.js'

/** 单次判定的默认 token 上限（只输出一个短 JSON 数组，600 已经绰绰有余）。 */
export const DEFAULT_MAX_TOKENS = 400

/** 单次判定的默认超时（慢思考可以慢，但不能把投递链路挂住）。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 单轮最多产出几条：多到 6 条基本就是模型在瞎编了。 */
export const MAX_JUDGED_THREADS = 6

/** 原文证据窗口：只看最近这么长的对话文本（超出部分对判定没帮助，只烧 token）。 */
export const MAX_RECENT_CHARS = 2000

const TYPE_LIST = THREAD_TYPES.join(' / ')

export const THREAD_JUDGE_SYSTEM = `你是聊天线索判定器。给你最近几轮对话，判断里面有没有「说了但还没了结」的事情，把它们挑出来。

只认这四类，type 必须照抄：
- temporary_leave：有人要去洗澡、吃饭、睡觉、上班、出门，或说「一会儿回来」
- promise：答应了或约定了什么（明天给你、回头发你、晚点分享）
- question_pending：问出去的问题对方还没回答
- topic_postponed：话说到一半被打断，或明确说「回头再说」

判断标准（很严）：
1. 必须**已经发生**在对话里，不能推测、不能编。原文里没有的事一律不要。
2. 必须**还没了结**：对方已经答了、事情已经办完了、话题已经翻篇了，都不算。
3. summary 必须用原文里的词（6 到 20 字），写清「谁要做什么」，不要概括成抽象结论。
4. 日常寒暄、情绪表达、一次性的问答不算线索。
5. 拿不准就不要输出。输出空数组是完全正常的答案。

只输出 JSON 数组，不要解释、不要 Markdown 代码块。格式：
[{"type":"temporary_leave","summary":"他说去洗澡，一会儿回来"}]

示例（照着这个颗粒度写）：
对话：
甲：我先去洗个澡，等我一下
乙：好，去吧
甲：对了明天把那个链接发你
判定：
[{"type":"temporary_leave","summary":"他去洗澡，让我等他"},{"type":"promise","summary":"他明天把链接发我"}]

反例（这些都不要输出）：
- 甲：今天好累啊 → 情绪表达，不是线索
- 甲：吃了吗 乙：吃了 → 已经答完了，不是 question_pending
- 甲：我去洗澡了 乙：洗完啦 → 已经了结，不是线索
- summary 写「用户的日常作息」→ 太抽象，原文里没有这个说法`

/**
 * 从模型输出里抠出 JSON 数组。容忍 ```json 围栏、前后废话、被截断的尾巴。
 * 解析不出来就是解析不出来（抛），由调用方 fail-open 成 []。
 */
export function parseJudgeOutput(raw) {
  let input = String(raw ?? '').trim()
  if (!input) throw new Error('模型未返回内容')
  const fence = input.match(/^```(?:json)?\s*\n?/i)
  if (fence) {
    input = input.slice(fence[0].length)
    const end = input.lastIndexOf('```')
    if (end >= 0) input = input.slice(0, end)
    input = input.trim()
  }
  const direct = tryParseArray(input)
  if (direct) return direct
  // 前后有废话：从每个 '[' 起找配平的数组
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== '[') continue
    const candidate = bracketSlice(input, i)
    if (!candidate) continue
    const parsed = tryParseArray(candidate)
    if (parsed) return parsed
  }
  throw new Error('模型返回的不是合法 JSON 数组')
}

function tryParseArray(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** 从 start 处的 '[' 找到配平的 ']'（字符串内的括号不算）。 */
function bracketSlice(input, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return input.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 去幻觉：summary 里的「实词锚点」必须在原文里出现过。
 *
 * 判定方式故意保守：把 summary 归一化（去标点空白）后切成 2 字滑窗，只要有**一个**
 * 窗在归一化原文里出现，就算有锚点。之所以不要求整句出现，是因为模型合理改写
 * （「他去洗澡」→「他说去洗澡」）不该被误杀；但凭空编出来的一整句（原文没有任何
 * 相同的两字组合）会被稳稳挡下。
 */
export function hasTextAnchor(summary, corpus) {
  const hay = normalizeThreadSummaryText(corpus, Number.MAX_SAFE_INTEGER)
  const needle = normalizeThreadSummaryText(summary, Number.MAX_SAFE_INTEGER)
  if (!needle || !hay) return false
  if (hay.includes(needle)) return true
  const points = Array.from(needle)
  if (points.length <= 2) return hay.includes(needle)
  for (let i = 0; i + 2 <= points.length; i += 1) {
    if (hay.includes(points.slice(i, i + 2).join(''))) return true
  }
  return false
}

/**
 * 把模型返回的原始条目录成可用的 `[{type, summary}]`：类型白名单 + 归一化 + 去幻觉 + 去重。
 * 纯函数，便于单测（不需要真模型）。
 */
export function sanitizeJudgedThreads(entries, corpus, { max = MAX_JUDGED_THREADS } = {}) {
  if (!Array.isArray(entries)) return []
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    if (out.length >= max) break
    if (!entry || typeof entry !== 'object') continue
    const type = String(entry.type ?? '').trim()
    if (!THREAD_TYPES.includes(type)) continue
    const summary = normalizeThreadSummaryText(entry.summary ?? '')
    if (!summary) continue
    if (!hasTextAnchor(summary, corpus)) continue
    const key = `${type}|${summary}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type, summary })
  }
  return out
}

/**
 * 跑一轮小模型判定，挑出值得挂起的未闭环线索。
 *
 * 任何异常（没模型、超时、报错、非法 JSON）都返回 `[]`：判定是增强项，不是主链路的必经环节。
 *
 * @param {object} input
 * @param {object} input.dsh 宿主 ctx
 * @param {object} input.cfg 插件配置（只透传给 askModel 选模型）
 * @param {string} input.chatKey 会话键（仅用于日志口径，不影响判定）
 * @param {string} input.recentText 最近几轮对话原文
 * @param {number} [input.now] 调用方时钟（本模块不读时钟）
 * @param {object} [input.deps] 测试注入口：`{ askModel }`（默认就是 src/core/llm.js 的实现）
 * @param {object} [input.log] 可选日志器（失败原因要能看见，但只用 warn/debug）
 * @param {number} [input.maxTokens]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<Array<{type:string, summary:string}>>}
 */
export async function judgeThreads({
  dsh, cfg, chatKey, recentText, now, deps, log,
  maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  void now
  const corpus = String(recentText ?? '').trim().slice(-MAX_RECENT_CHARS)
  if (!corpus) return []
  const ask = deps && typeof deps.askModel === 'function' ? deps.askModel : askModel
  const warn = (msg) => { try { log?.warn?.(msg) } catch { /* 日志器自己炸了也不管 */ } }

  let raw = ''
  try {
    raw = await runWithTimeout(
      (signal) => ask(dsh, {
        cfg,
        system: THREAD_JUDGE_SYSTEM,
        text: `最近几轮对话：\n${corpus}`,
        maxTokens,
        temperature: 0.1,
        signal,
      }),
      timeoutMs,
    )
  } catch (error) {
    warn(`线索判定跳过（模型不可用）：${chatKey || '?'} ${error?.message || error}`)
    return []
  }

  try {
    const entries = parseJudgeOutput(raw)
    return sanitizeJudgedThreads(entries, corpus)
  } catch (error) {
    warn(`线索判定跳过（输出非法）：${chatKey || '?'} ${error?.message || error}`)
    return []
  }
}

/** 给 askModel 套一层超时（它自己有 120s 兜底，慢思考不能等那么久）。 */
async function runWithTimeout(run, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const controller = new AbortController()
  let timer = null
  // 超时定时器**绝不能 unref**：它存在的意义就是「保证进程活到它触发为止」。
  // unref 之后若此刻没有别的 ref 定时器托住事件循环（CI 上单文件跑、本地恰好被别的测试托住），
  // Node 会直接判定「事件循环已排空 → 有未结算的 top-level await」，
  // Promise.race 永远等不到结果，表现为 ERR_TEST_FAILURE: Promise resolution is still pending。
  // （被 race 的另一半——模型请求——可以是 unref，它只是被动等待者，不负责撑住事件循环。）
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`线索判定超过 ${Math.ceil(ms / 1000)} 秒，已中止`)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 判定提示词里声明的类型清单（面板/文档展示用，避免两处手写漂移）。 */
export function describeJudgeTypes() {
  return `可选类型：${TYPE_LIST}`
}