// 回合失败处理：超时、请求体过大（413 / 插件内存上限）、被宿主归档门拦下（blocked）。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致：文案、时序、标记集合都没动）。
// 三者同一条纪律：**这里只记标记 + 提示用户**，真正的归档重建（resetChat）留到下一条
// 消息进入 execute 时做 —— 回合失败路径此刻事件监听还没走完，立刻归档会和宿主自己的
// 事件处理打架（原注释见各函数）。
//
// 依赖：outbox 走 getOutbox 取数函数（它在本模块装配之后创建）；「待重置」标记表
// `pendingResets`（chatKey → 理由）由核心持有并**以活引用传入**——execute / runPromptTurn
// 读同一份标记决定是否换会话，复制一份就会漂移。
//
// 结构（S1）：四类失败共用一张 `pendingResets` 表 + 一个分类函数 `classifyFailureKind`，
// 一个统一入口 `handleTurnFailure` 按分类分派到下面三个既有处理函数。分派不改变任何一条
// 既有文案、notify 语义与时序：本文件里每个 handler 的日志文本与拆分前逐字相同。
//
// 命名注意：本模块导出的 `handleTurnFailure`（分派壳）**不要在装配根里同名解构** ——
// #263 在 host/modular-core.js 里另有一个 `handleTurnFailure`（分类回执，语义完全不同）。
// 装配根只取下面三个既有 handler，按 #263 的四个出口分工显式调用。

import { redact } from '../../core/redact.js'

// ---------- 待重置标记：pendingResets（S1 合并三个 Set，rebase 并入第 4 个） ----------
// 拆分前是三个独立 Set（timedOutChats / oversizedChats / archivedChats），#263 又加了第四个
// （contextResetChats：模型上下文超窗）。同一个 chatKey 允许被标上多条理由，合并成 Map 后
// `set` 会覆盖，所以这里显式定强弱：
//   归档门拦下（archived）> 上下文超窗（context-window）> 请求体过大（oversized）> 超时（timedOut）。
// 后写入的低优先级**不得**覆盖已存在的高优先级 —— 重复标记不能把更强的自愈理由丢掉。
const PENDING_RESET_RANK = { timedOut: 0, oversized: 1, 'context-window': 2, archived: 3 }
const rankOf = (reason) => PENDING_RESET_RANK[reason] ?? -1

/**
 * 记一条待重置标记（优先级合并，不降级）。
 * @param {Map<string, string>} pendingResets 待重置标记表。
 * @param {string} chatKey 聊天键。
 * @param {'timedOut'|'oversized'|'context-window'|'archived'} reason 自愈理由。
 * @returns {string} 合并后表里实际生效的理由（被高优先级挡住时原样返回旧值）。
 */
export function markPendingReset(pendingResets, chatKey, reason) {
  const key = String(chatKey || '')
  const prev = pendingResets.get(key)
  if (prev !== undefined && rankOf(prev) > rankOf(reason)) return prev
  pendingResets.set(key, reason)
  return reason
}

/**
 * 取出该聊天的待重置理由（**取出即清除**：同一个标记只会触发一次 resetChat）。
 * 只负责取，打不打日志、通知不通知由调用点各自决定（execute 有文案，runPromptTurn 没有）。
 * @param {Map<string, string>} pendingResets 待重置标记表。
 * @param {string} chatKey 聊天键。
 * @returns {'timedOut'|'oversized'|'context-window'|'archived'|null} 理由；没有标记时返回 null。
 */
export function takePendingReset(pendingResets, chatKey) {
  const key = String(chatKey || '')
  const reason = pendingResets.get(key)
  if (reason === undefined) return null
  pendingResets.delete(key)
  return reason
}

// ---------- 413 / 请求体过大自愈 ----------
// DeepSeek 服务端对「会话累计上下文 + 图片字节」有一个按会话计的硬上限（真机 2026-11-19：
// 413 plugin_request_too_large「本次对话上下文或图片过大……插件内存上限 64 MiB」）。这不是
// 单次请求能靠删图救回的：旧会话的历史每轮都重放，超限后**之后每一轮都必然 413**，会话
// 永久卡死。DSH 把 413 归类为 INVALID_REQUEST（不重试），turn/end 落 error，本轮「不发」。
//
// 唯一可靠的恢复 = 换新会话（归档旧的，下一条消息自动新建）。与 handleTurnTimeout 同款模式：
// 这里只记标记 + 提示，真正 resetChat 在下一条消息进入 execute 时做（避免在回合失败路径里
// 立刻归档——此刻事件监听还没走完，且用户可能正在面板里翻这个会话）。
//
// 识别口径（宁可多识别不漏判，因为误伤代价只是多一次归档重建）：
//   · DSH 结构化失败码：turn/end reason.error.code === 'INVALID_REQUEST' 且 status === 413；
//   · 服务端错误文案特征：plugin_request_too_large / 「上下文或图片过大」 / 「插件内存上限」；
//   · 兜底：INVALID_REQUEST 且消息含 too large / 413（防服务端换措辞）。
// DSH 会话修复（repair.ts）合成的 turn/end 不带 error 细节（只有 kind），那类不是 413，天然不命中。
const OVERSIZE_MESSAGE_RE = /plugin_request_too_large|上下文或图片过大|插件内存上限|\b413\b|too\s+large/i
// 服务端「请求体/会话累计过大」的**强特征**。这些词只可能来自「发出去的东西太大」，
// 不可能来自「模型的 token 上下文窗口不够」，所以不看 code、不看 status 都成立。
//
// 为什么必须不看 code（真机 2026-11-20，同一个群连挂 6 轮）：
//   该聊天的模型走 pi-ai 路由（第三方 OpenAI 兼容提供方），错误分类走 dsh-llm-pi-ai 的
//   `isContextOverflow()`，而它把 Anthropic 的 /request_too_large/i 当「上下文溢出」——
//   我们的 `plugin_request_too_large` **正好含这个子串**，于是被判成
//   `CONTEXT_WINDOW_EXCEEDED`（pi-ai 路径还不填 status）。后果有两层：
//     ① dsh-compaction-basic 见 code 就压缩重试。但压缩请求本身也要把同一份超大历史
//        发给模型算摘要，所以它同样 413（真机 compaction/end 的 error 就是同一条 413）——
//        摘要算不出来、历史字节一个没少，纯空转，还把「该换会话」拖到下一条消息；
//     ② 本函数的旧口径要求 `INVALID_REQUEST` 或 `status === 413`，两个都不匹配，
//        自愈一次没触发，会话就一直卡在同一个超限历史里。
//   所以改成「文案优先」：只要出现这些强特征词就认定是请求体过大。
const SERVER_OVERSIZE_TEXT = /plugin_request_too_large|request_too_large|context_too_large|请求体过大|上下文或图片过大|插件内存上限|request\s+body\s+too\s+large|payload\s+too\s+large/i
/**
 * 失败是否「请求体过大」（413 / 插件内存上限）。
 *
 * 判定条件与拆分前**逐字相同**（只是从工厂内部提到模块作用域，供 classifyFailureKind 复用；
 * 工厂仍返回同一个函数引用，调用方拿到的行为不变）。
 * @param {object|null} failure 失败对象（可能只有 code / status / message 之一）。
 * @returns {boolean} 是否按请求体过大处理。
 */
export function turnFailureLooksOversized(failure) {
  if (!failure || typeof failure !== 'object') return false
  const code = String(failure.code || '')
  const status = Number(failure.status) || 0
  const message = String(failure.message || '')
  if (status === 413) return true
  // 文案优先：不依赖 code/status（pi-ai 会把 plugin_request_too_large 误判成上下文超限）
  if (SERVER_OVERSIZE_TEXT.test(message)) return true
  if (code === 'INVALID_REQUEST' && OVERSIZE_MESSAGE_RE.test(message)) return true
  // 某些路径（repair 合成 / 旧宿主）没有 status，只有 message：特征词唯一性足够强
  if (!code && OVERSIZE_MESSAGE_RE.test(message) && /413|过大|too large|too_large/i.test(message)) return true
  return false
}

// ---------- 分类：一个入口认出「这是哪类失败」 ----------
/**
 * 把一次回合失败归类（纯函数，不看状态、不打日志）。
 *
 * 名字刻意叫 `classifyFailureKind`：#263 在 host/modular-core.js 里有一个 `classifyTurnFailure`，
 * 它把失败归成 moderation / rate-limit / context-window / error 并发用户回执。两者语义完全不同，
 * 同名会串；本函数只回答「这一轮要不要换会话、按什么理由换」。
 *
 * 四类：`oversized`（服务端 413 / 请求体过大）、`archived`（DSH 归档门 blocked）、
 * `timedOut`（本地等待超时）、`other`（其余一律原样如实失败）。
 *
 * 判定口径：`oversized` 完全复用 turnFailureLooksOversized（正则与字段判断一字未改）；
 * `archived` 只认结构标记 kind === 'blocked'（blocked 没有 error 细节，不能靠文案判）；
 * `timedOut` 只认我们自己在超时 error 上打的 turnTimedOut（DSH 侧没有这个标记）。
 * @param {object|string|null} failure 失败对象 / 失败标记。
 * @returns {{kind: 'oversized'|'archived'|'timedOut'|'other', oversized: boolean, archived: boolean, timedOutForMs: number}}
 */
export function classifyFailureKind(failure) {
  if (turnFailureLooksOversized(failure)) return { kind: 'oversized', oversized: true, archived: false, timedOutForMs: 0 }
  const kind = typeof failure === 'string' ? failure : String(failure?.kind || '')
  if (kind === 'blocked') return { kind: 'archived', oversized: false, archived: true, timedOutForMs: 0 }
  // T3.4：字段统一 —— TurnExecutionError 打的是 timedOut，历史链路打的是 turnTimedOut，两个都认。
  if (failure && typeof failure === 'object' && Boolean(failure.timedOut || failure.turnTimedOut)) {
    return { kind: 'timedOut', oversized: false, archived: false, timedOutForMs: Number(failure.timedOutForMs ?? failure.timeoutMs) || 0 }
  }
  return { kind: 'other', oversized: false, archived: false, timedOutForMs: 0 }
}

/**
 * 回合失败处理器装配。
 *
 * @param {object} o 依赖。
 * @param {object} o.log 日志器。
 * @param {(m: string) => void} o.debug 调试日志。
 * @param {() => object} o.getOutbox 取数：outbox（装配后才创建）。
 * @param {Map<string, string>} o.pendingResets 待重置标记表（活引用，与核心共用一份）。
 */
export function createTurnFailure({ log, debug, getOutbox, pendingResets }) {
  function handleTurnTimeout(chatKey, timeoutMs, { notify = true } = {}) {
    markPendingReset(pendingResets, chatKey, 'timedOut')
    const minutes = Math.max(1, Math.ceil(timeoutMs / 60000))
    log.warn(`回合超过 ${minutes} 分钟未结束：${chatKey}；已释放等待，下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(getOutbox().request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: `刚才的回复超过 ${minutes} 分钟还没完成，我先停止等待了，这条旧回复不会再补发。你发下一条消息时我会重新开始。` } }],
    })).catch((error) => debug(`回合超时提示没发出去：${error?.message || error}`))
  }

  /** 回合因请求体过大失败：记标记、提示用户；下一条消息进入时自动归档重建会话。 */
  function handleOversizedTurn(chatKey, failure, { notify = true } = {}) {
    markPendingReset(pendingResets, chatKey, 'oversized')
    const detail = String(failure?.message || '').replace(/\s+/g, ' ').slice(0, 120)
    log.warn(`回合因请求体过大被服务端拒绝（413/插件内存上限）：${chatKey}${detail ? '：' + redact(detail) : ''}；下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(getOutbox().request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: '这个会话攒的上下文和图片太多，服务端拒绝了（超过 64 MiB 上限），这轮没法回。你发下一条消息时我会自动重新开始（旧对话会归档，可以随时找回）；图片类内容也会少带一些。' } }],
    })).catch((error) => debug(`请求体过大提示没发出去：${error?.message || error}`))
  }
  /**
   * 回合被 DSH 归档门拒绝（`turn/end` 的 kind 是 `blocked`）：记标记，下一条消息进来时换新会话。
   *
   * `blocked` 没有 error 细节（不是模型错误、不是 413），所以不能靠 failure 判定，
   * 只能认 kind。它比 413 更"干净"：服务端一次都没被调用，纯粹是宿主拒绝在已归档会话上开步骤。
   * @param {string} chatKey 聊天键。
   */
  function handleArchivedTurn(chatKey) {
    markPendingReset(pendingResets, chatKey, 'archived')
    log.warn(`回合被宿主归档门拦下（blocked）：${chatKey} 的会话已归档，下一条消息将换新会话`)
  }

  /**
   * 统一入口：按 classifyFailureKind 分派到上面三个既有 handler（'context-window' 由 #263 那一侧
   * 分类后直接 markPendingReset，不进本入口）。
   *
   * 分派是**薄壳**：每个 handler 自己的日志文案、通知语义、标记优先级一字未改；
   * `other` 不做任何事（调用点原本就没有对应分支，如实失败由调用点自己上抛）。
   * @param {string} chatKey 聊天键。
   * @param {object|null} failure 失败对象（可带 kind / code / status / message / turnTimedOut / timedOutForMs）。
   * @param {{notify?: boolean, source?: string}} [opts] notify 默认 true（与各 handler 一致）；
   *   source 仅作调用点标注（日志文案不因来源变化，故不参与输出）。
   */
  function handleTurnFailure(chatKey, failure, opts = {}) {
    const notify = opts.notify !== false
    const classified = classifyFailureKind(failure)
    if (classified.kind === 'oversized') return handleOversizedTurn(chatKey, failure, { notify })
    if (classified.kind === 'archived') return handleArchivedTurn(chatKey)
    if (classified.kind === 'timedOut') return handleTurnTimeout(chatKey, classified.timedOutForMs, { notify })
    return null
  }

  return { handleTurnTimeout, turnFailureLooksOversized, handleOversizedTurn, handleArchivedTurn, classifyFailureKind, handleTurnFailure }
}
