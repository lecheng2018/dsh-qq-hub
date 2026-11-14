// M2-E · Context Assembly：模块上下文 provider 的统一装配（纯模块）
//
// 职责（任务书 M2-E + ADR-0001 ContextFragment 契约）：
//   - 聚合所有模块 provider；保留优先级、scope（ChatKey 或 global）、sessionId、
//     稳定缓存顺序和错误隔离；
//   - 错误策略只有两种（ADR）：isolate（该 provider 出错跳过，其他照常）/ fail-closed
//     （该 provider 出错 = 整次装配失败，绝不带残缺上下文继续）——按 provider 声明执行；
//   - 无 scope 时 fail-closed（拿不到可信作用域就不注入，绝不全库兜底）；
//   - 装配顺序稳定：priority 降序，同优先级按注册序（缓存稳定，不随 Map 迭代漂移）。
//
// 红线：本模块不读模块数据库、不 import 任何业务模块；provider 是注入的黑盒函数。
//
// Phase 2 追加（本节）：出厂两个连续性 provider 构造器——
//   - createThreadProvider（priority 800）：把「去洗澡了 / 答应明天分享新歌」这类未闭环线索
//     连同时空标尺注入上下文（文案形如「[当前状态：对方 45 分钟前说去洗澡了，现在差不多该回来了]」）；
//   - createTimeScaleProvider（priority 790）：给模型相对时间感，避免三天前的约定被当成刚才说的。
// 二者都只吃**注入**的账本 / 时间源（不 import thread-ledger 具体实现），无 scope 一律不注入，
// 越界（群聊 scope 读到私聊线索）直接抛 ThreadScopeLeakError。

import { assertContextFragment } from '../kernel/modular-contracts.js'
import { parseChatKey } from './chat-key.js'

/**
 * @param {object} o
 * @param {Array<{moduleId: string, priority?: number, scope?: string, sessionId?: string,
 *   cacheStable?: boolean, onError?: 'isolate'|'fail-closed',
 *   provide: (req: {chatKey: string, sessionId?: string}) => (string | {content: string, sessionId?: string, scope?: string})}>} o.providers
 */
export function createContextAssembly({ providers = [] } = {}) {
  const registered = providers.map((p, index) => normalizeProvider(p, index))

  function normalizeProvider(p, index) {
    if (!p || typeof p !== 'object') throw new TypeError('provider 必须是对象')
    if (typeof p.moduleId !== 'string' || !p.moduleId) throw new TypeError('provider 缺 moduleId')
    if (typeof p.provide !== 'function') throw new TypeError(`provider ${p.moduleId} 缺 provide()`)
    if (p.scope !== undefined && p.scope !== 'global') parseChatKey(p.scope) // 声明即校验
    return {
      moduleId: p.moduleId,
      order: index,
      priority: typeof p.priority === 'number' && Number.isFinite(p.priority) ? p.priority : 0,
      scope: p.scope ?? 'global',
      sessionId: p.sessionId,
      cacheStable: p.cacheStable ?? false,
      onError: p.onError === 'fail-closed' ? 'fail-closed' : 'isolate',
      provide: p.provide,
    }
  }

  /** 注册（模块启停/热重载时由装载层调用）。 */
  function register(provider) {
    const norm = normalizeProvider(provider, registered.length)
    registered.push(norm)
    return () => unregister(norm.moduleId)
  }

  function unregister(moduleId) {
    const i = registered.findIndex((p) => p.moduleId === moduleId)
    if (i >= 0) registered.splice(i, 1)
  }

  /**
   * 装配一次上下文。
   * @param {object} req
   * @param {string} req.chatKey 当前聊天
   * @param {string} [req.sessionId] 当前会话（provider 声明的 sessionId 缺省时用它）
   * @returns {Promise<{ fragments: Array<object>, errors: Array<{moduleId, message}> }>}
   */
  async function assemble(req) {
    const chatKey = String(req?.chatKey ?? '')
    parseChatKey(chatKey) // 无可信聊天域 = fail-closed（调用方先修 ChatKey）
    const sessionId = req?.sessionId ? String(req.sessionId) : undefined

    // 作用域过滤：provider.scope='global' 全局可见；scope 是 ChatKey 时仅该聊天可见
    // （群聊拿不到私聊记忆 = 物理隔离的声明式表达）
    const eligible = registered.filter((p) => p.scope === 'global' || p.scope === chatKey)
    // 稳定顺序：priority 降序，同优先级按注册序
    const ordered = [...eligible].sort((a, b) => (b.priority - a.priority) || (a.order - b.order))

    const fragments = []
    const errors = []
    for (const p of ordered) {
      try {
        const raw = await p.provide({ chatKey, sessionId, chat: req?.chat }) // chat 视图透传（legacy provider 契约吃 chat 对象）
        const content = typeof raw === 'string' ? raw : String(raw?.content ?? '')
        if (!content) continue // 空贡献不产出 fragment（不占装配位）
        const frag = {
          contractVersion: 1,
          moduleId: p.moduleId,
          scope: p.scope === 'global' ? 'global' : chatKey,
          sessionId: p.sessionId ?? sessionId,
          priority: p.priority,
          cacheStable: p.cacheStable,
          onError: p.onError,
          content,
        }
        assertContextFragment(frag)
        fragments.push(frag)
      } catch (error) {
        errors.push({ moduleId: p.moduleId, message: String(error?.message || error) })
        if (p.onError === 'fail-closed') {
          // 该 provider 出错 = 整次装配失败（绝不带残缺上下文继续）
          throw Object.assign(new Error(`context provider ${p.moduleId} fail-closed：${error?.message || error}`), {
            moduleId: p.moduleId,
            cause: error,
          })
        }
        // isolate：跳过该 provider，其余照常
      }
    }
    return { fragments, errors }
  }

  return { assemble, register, unregister }
}

// ---------------------------------------------------------------------------
// Phase 2 · 连续性 provider：挂起线索（thread）与时空连续标尺（time-scale）
//
// 这两个 provider 是本模块**出厂自带**的构造器，但依然遵守「零业务 import」红线：
// 线索数据一律从注入的 ledger 拿（只认 peek 这一个方法），绝不 import
// src/chat/thread-ledger.js 的具体实现——Provider 与账本解耦，测试可注入假账本。
//
// 硬规则：
//   1. 无 scope（未绑定 ChatKey）= fail-closed：provide() 返回空串，绝不注入（也不全库兜底）；
//   2. 越界即报错：ledger 返回的线索 chatKey 与本 provider 的 scope 不一致（典型=
//      群聊 scope 读到私聊线索）时抛 ThreadScopeLeakError，绝不把私聊线索塞进群聊上下文；
//   3. 错误策略 isolate：单个 provider 出错只跳过自己，其余上下文照常装配（隐私越界除外，
//      上层可按需要显式改 fail-closed，本模块不自作主张）。
//
// 线索注入文案（含时空标尺，形如「对方 45 分钟前说去洗澡，现在刚回来」）：
//   [当前状态：对方 45 分钟前说去洗澡，现在差不多该回来了]
// ---------------------------------------------------------------------------

/** 挂起线索 provider 的模块 ID（装配排序与错误定位都靠它）。 */
export const THREAD_PROVIDER_ID = 'thread-ledger'

/** 挂起线索 provider 的优先级：高于普通记忆（100），低于人格卡（200+），一句话压在最前。 */
export const THREAD_PROVIDER_PRIORITY = 800

/** 时空连续标尺 provider 的模块 ID。 */
export const TIME_SCALE_PROVIDER_ID = 'time-scale'

/** 时空标尺优先级：紧跟线索之后（线索优先，标尺补时间感）。 */
export const TIME_SCALE_PROVIDER_PRIORITY = 790

/** 线索摘要进提示词的长度上限（code point；超长截断，绝不整条丢弃）。 */
export const MAX_INJECT_SUMMARY_CHARS = 120

/**
 * 跨作用域读线索（群聊 scope 读到私聊线索等）：越界即报错，不是静默丢弃。
 * 上层 isolate 策略下只会跳过本 provider，但错误一定出现在 errors 里可审计。
 */
export class ThreadScopeLeakError extends Error {
  constructor(ownerScope, recordChatKey) {
    super(`挂起线索越界：provider scope ${JSON.stringify(ownerScope)} 读到了 ${JSON.stringify(recordChatKey)} 的线索，拒绝注入（跨域 = 隐私泄漏）`)
    this.name = 'ThreadScopeLeakError'
    this.code = 'CONTEXT_THREAD_SCOPE_LEAK'
    this.scope = ownerScope
    this.recordChatKey = recordChatKey
  }
}

const SUMMARY_ELLIPSIS = '…'

/** 把毫秒差格式化成中文相对时长（纯函数，负值按 0 处理）；超过一天带天数。 */
export function formatElapsedMs(ms) {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  const minutes = Math.floor(value / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

/** 线索类型 → 「现在怎样了」的顺承提示（类型未知时不猜，给中性兜底）。 */
const THREAD_STATUS_HINTS = Object.freeze({
  temporary_leave: '现在差不多该回来了',
  promise: '这事还记着',
  question_pending: '还在等对方回答',
  topic_postponed: '话题还悬着一半',
})

function hintOfThread(type) {
  return THREAD_STATUS_HINTS[type] || '线索还没闭环'
}

/** 归一摘要：压空白 + 按 code point 截断（与 thread-ledger 的进词口径一致）。 */
function injectableSummary(summary) {
  if (typeof summary !== 'string') return '' // 非法类型不猜（数字/对象一律不注入）
  const text = summary.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const points = Array.from(text)
  if (points.length <= MAX_INJECT_SUMMARY_CHARS) return text
  return points.slice(0, MAX_INJECT_SUMMARY_CHARS - SUMMARY_ELLIPSIS.length).join('') + SUMMARY_ELLIPSIS
}

/** 线索记录 → 一行注入文案（时间标尺 + 摘要 + 当前状态）。 */
export function formatThreadLine(thread, now) {
  if (!thread || typeof thread !== 'object') return ''
  const summary = injectableSummary(thread.summary)
  if (!summary) return '' // 没有摘要的线索进上下文只是噪音
  const createdAt = typeof thread.createdAt === 'number' && Number.isFinite(thread.createdAt) ? thread.createdAt : now
  const elapsed = Math.max(0, Number(now) - createdAt)
  // 刚说完的话不说「0 分钟前」，用「刚才」——标尺要像人话
  const when = elapsed < 60_000 ? '刚才' : `${formatElapsedMs(elapsed)}前`
  return `[当前状态：对方 ${when}说${summary}，${hintOfThread(thread.type)}]`
}

/**
 * 建一个「挂起线索」provider（priority 800，isolate）。
 *
 * @param {object} o
 * @param {object} o.ledger 挂起线索账本（只要求有 peek(chatKey, opts) 方法，注入而非 import）
 * @param {string} [o.scope] 绑定的 ChatKey；缺省 = 无 scope，provide() 一律不注入（fail-closed）
 * @param {() => number} [o.now] 可注入时钟（测试与回放用），缺省 Date.now
 * @param {boolean} [o.includeDormant] 是否把休眠线索也算进来（默认不看：休眠不是第一顺位）
 * @param {boolean} [o.perChat] 按每次请求的 chatKey 现算作用域（宿主装配只有一个全局实例时必须开这个）。
 *   默认 false：保持「无 scope 即 fail-closed，絕不全库兜底」的原契约，既有行为不变。
 */
export function createThreadProvider({ ledger, scope, now = Date.now, includeDormant = false, perChat = false } = {}) {
  if (!ledger || typeof ledger.peek !== 'function') {
    throw new TypeError('createThreadProvider 需要注入带 peek() 的 ledger（本模块不 import 账本实现）')
  }
  if (scope !== undefined && scope !== 'global') parseChatKey(scope) // 声明即校验

  /**
   * 这一次请求的作用域。
   * - perChat=false（默认）：用构造时绑定的 scope；无 scope = 不注入（fail-closed）。
   * - perChat=true：用请求带来的 chatKey，且必须过 parseChatKey 校验——
   *   宿主里只会建一个全局实例，作用域只能来自请求；但「来自请求」不等于「可信」，
   *   非法 ChatKey 一律当无 scope 处理，仍然不查账本。
   */
  const scopeOf = (reqChatKey) => {
    if (!perChat) return scope
    if (!reqChatKey) return undefined
    try {
      // parseChatKey 返回 { kind, id }，**没有** chatKey 字段；直接取 .chatKey 会恒得 undefined
      // 从而让 perChat 永远 fail-closed（接线看似在、实际不注入）。这里显式重组成规范形态。
      const { kind, id } = parseChatKey(String(reqChatKey))
      return `${kind}:${id}`
    } catch { return undefined }
  }

  const provide = ({ chatKey } = {}) => {
    const resolved = scopeOf(chatKey)
    // 无 scope = fail-closed：拿不到可信作用域就不注入，绝不全库兜底
    if (!resolved || resolved === 'global') return ''
    // 装配层已按 scope 过滤，这里再校一遍：provider 被错用时绝不串域
    if (resolved !== chatKey) return ''
    const when = typeof now === 'function' ? now() : now
    const record = ledger.peek(resolved, { now: when, includeDormant })
    if (!record) return ''
    // 越界即报错：群聊 scope 拿到私聊线索（或任何别的聊天域）一律抛，不静默吞
    if (record.chatKey !== resolved) throw new ThreadScopeLeakError(resolved, record.chatKey)
    return formatThreadLine(record, when)
  }

  return {
    moduleId: THREAD_PROVIDER_ID,
    priority: THREAD_PROVIDER_PRIORITY,
    scope: scope ?? 'global',
    cacheStable: false, // 线索随时会变，不能进稳定缓存段
    onError: 'isolate',
    provide,
  }
}

/** 「多久没聊」→ 顺承提示（纯函数；阈值固定，便于回放复现）。 */
export function formatGapHint(ms) {
  const minutes = Math.floor((typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0) / 60_000)
  if (minutes < 5) return '话头还是热的'
  if (minutes < 120) return '刚离开一小会儿'
  if (minutes < 1440) return '隔了几个钟头'
  return '隔了不止一天，对方可能已经忘了上下文'
}

/**
 * 建一个「时空连续标尺」provider（priority 790，isolate）：给模型相对时间感，
 * 避免「三天前的约定」被当成「刚才说的」。
 *
 * @param {object} o
 * @param {string} [o.scope] 绑定的 ChatKey；缺省 = 无 scope，provide() 不注入（fail-closed）
 * @param {(chatKey: string) => (number|null|undefined)} [o.resolveLastAt] 上次互动时间戳来源（注入）
 * @param {() => number} [o.now] 可注入时钟
 * @param {boolean} [o.perChat] 按每次请求的 chatKey 现算作用域（同 thread provider，默认 false）
 */
export function createTimeScaleProvider({ scope, resolveLastAt, now = Date.now, perChat = false } = {}) {
  if (resolveLastAt !== undefined && typeof resolveLastAt !== 'function') {
    throw new TypeError('createTimeScaleProvider 的 resolveLastAt 必须是函数或留空')
  }
  if (scope !== undefined && scope !== 'global') parseChatKey(scope)

  const scopeOf = (reqChatKey) => {
    if (!perChat) return scope
    if (!reqChatKey) return undefined
    try {
      // parseChatKey 返回 { kind, id }，**没有** chatKey 字段；直接取 .chatKey 会恒得 undefined
      // 从而让 perChat 永远 fail-closed（接线看似在、实际不注入）。这里显式重组成规范形态。
      const { kind, id } = parseChatKey(String(reqChatKey))
      return `${kind}:${id}`
    } catch { return undefined }
  }

  const provide = ({ chatKey } = {}) => {
    const resolved = scopeOf(chatKey)
    if (!resolved || resolved === 'global') return '' // 无 scope = fail-closed 不注入
    if (resolved !== chatKey) return ''
    if (typeof resolveLastAt !== 'function') return '' // 没有时间源就不编造时间
    const lastAt = resolveLastAt(resolved)
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0) return ''
    const when = typeof now === 'function' ? now() : now
    const elapsed = Math.max(0, Number(when) - lastAt)
    return `[时空标尺：距上一轮对话 ${formatElapsedMs(elapsed)}（${formatGapHint(elapsed)}）]`
  }

  return {
    moduleId: TIME_SCALE_PROVIDER_ID,
    priority: TIME_SCALE_PROVIDER_PRIORITY,
    scope: scope ?? 'global',
    cacheStable: false,
    onError: 'isolate',
    provide,
  }
}

// ---------------------------------------------------------------------------
// US-015 · 关系温度 provider（affective-graph → 上下文）
//
// 信任图谱算得出「这个人是熟络好友 / 挚友」，但此前 tone() 全仓零调用方：
// 等级再高也不会影响一句话。本 provider 把 tone 变成一段**简短**的姿态提示，让
// temperature / jokeScale 真的落到回复里。
//
// 硬规则（同线索 provider 的口径）：
//   1. **等级 0（陌生人）不注入任何内容**——不打扰，也不给每条消息塞一句「你是陌生人」；
//   2. 作用域只来自本次请求的 chatKey（perChat）：群聊读群、私聊读私聊，绝不跨域读；
//      非法 ChatKey 一律不注入（fail-closed，不猜"就是本会话"）；
//   3. 错误策略 isolate：toneFor 缺失 / 抛错 / 返回怪形状 → 跳过本 provider，其余上下文照常；
//   4. 文案有长度上限，且不暴露原始分数（面板看解释，模型只看姿态）。
// ---------------------------------------------------------------------------

/** 关系温度 provider 的模块 ID。 */
export const AFFECTIVE_PROVIDER_ID = 'affective-graph'

/** 关系温度优先级：低于线索(800)/标尺(790)，高于普通记忆(100)——姿态是"语气"，不是"事实"。 */
export const AFFECTIVE_PROVIDER_PRIORITY = 780

/** temperature → 「说话可以多暖」的白话（未收录的取值不猜，一律按中性不注入）。 */
const TEMPERATURE_HINTS = Object.freeze({
  cool: '说话收敛一点，不必刻意热络',
  warm: '说话温度可以暖一点',
  intimate: '说话可以更放松更亲近',
})

/**
 * tone → 一行注入文案。纯函数，便于单测与回放。
 * 陌生人（level 0）/ 形状非法 / 温度不在词表 → 返回 ''（不注入）。
 */
export function formatAffectiveLine(tone) {
  if (!tone || typeof tone !== 'object') return ''
  const level = Number(tone.level)
  if (!Number.isInteger(level) || level <= 0) return '' // 等级 0 = 陌生人：不打扰
  const label = typeof tone.label === 'string' && tone.label.trim() ? tone.label.trim().slice(0, 12) : '熟人'
  const hint = TEMPERATURE_HINTS[String(tone.temperature || '')]
  if (!hint) return ''
  const scale = Number(tone.jokeScale)
  const joke = Number.isFinite(scale) && scale >= 0
    ? `玩笑尺度 ${Math.round(Math.min(1, scale) * 10) / 10}`
    : ''
  const tail = joke ? `${hint}，${joke}。` : `${hint}。`
  return `（你和这个人：${label}。${tail}）`
}

/**
 * 建一个关系温度 provider（priority 780，isolate）。
 *
 * @param {object} o
 * @param {(chatKey: string) => ({level?: number, label?: string, temperature?: string, jokeScale?: number}|null)} [o.resolveTone]
 *   从**当前运行中**的图谱取姿态（注入而非 import：模块被关掉/替换时必须现取并优雅降级）。
 *   缺省或返回 null → 不注入。
 * @param {string} [o.scope] 绑定的 ChatKey；缺省 = 跟随每次请求（perChat 语义）。
 * @param {boolean} [o.perChat] 按每次请求的 chatKey 现算作用域（宿主只有一个全局实例，必须开）。
 */
export function createAffectiveProvider({ resolveTone, scope, perChat = true } = {}) {
  if (resolveTone !== undefined && typeof resolveTone !== 'function') {
    throw new TypeError('createAffectiveProvider 的 resolveTone 必须是函数或留空')
  }
  if (scope !== undefined && scope !== 'global') parseChatKey(scope)

  const scopeOf = (reqChatKey) => {
    if (!perChat) return scope
    if (!reqChatKey) return undefined
    try {
      const { kind, id } = parseChatKey(String(reqChatKey))
      return `${kind}:${id}`
    } catch { return undefined }
  }

  const provide = ({ chatKey } = {}) => {
    const resolved = scopeOf(chatKey)
    if (!resolved || resolved === 'global') return '' // 无 scope = 不注入
    if (resolved !== chatKey) return '' // 装配层已按 scope 过滤，这里再校一遍
    if (typeof resolveTone !== 'function') return ''
    // 这里不 try/catch：抛错交给装配层的 isolate 记进 errors（可审计），
    // 但绝不让它影响别的 provider —— 那正是 onError: 'isolate' 的契约。
    const tone = resolveTone(resolved)
    // toneFor 的失败形状（{ok:false}）也不注入：拿不到可信等级就别装熟。
    if (tone && tone.ok === false) return ''
    return formatAffectiveLine(tone)
  }

  return {
    moduleId: AFFECTIVE_PROVIDER_ID,
    priority: AFFECTIVE_PROVIDER_PRIORITY,
    scope: scope ?? 'global',
    cacheStable: false, // 等级会变，不能进稳定缓存段
    onError: 'isolate',
    provide,
  }
}
