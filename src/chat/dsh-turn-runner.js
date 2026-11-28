// S2 · DSH 回合执行器：把「跑一个 DSH 回合、收集回复文本」收成一处，两条链共用。
//
// 拆分前有两套实现，机制重复、细节漂移：
//   A 聊天主链 host/modular-core.js 的 execute：steer 分段、末步回退、`|||` 拼接、报告标记；
//   B 后台主动回合 runPromptTurn：只取最后一条正文，忽略 tool/call，没有 typing/steer。
// 真正相同的是「DSH 事件机 + 超时 + 失败分类 + 监听器摘除 + 取消」，就是本模块的全部内容。
// 各自独有的语义（typing、表情台账、群缓冲标 fed、投递、steer 的上下文拼装、模型/人设挂载）
// 一行都没搬，仍留在原来的调用点。
//
// 设计要点：
//   · `collect.mode` 决定文本收集策略：`'chat'` 打开分段拼接 + 末步回退 + 报告标记上报；
//     `'prompt'` 只留最后一条正文、忽略 tool/call（与拆分前的 B 逐行等价）。
//   · 超时 / 取消 / 回合非 completed / 事件流缺失一律抛 `TurnExecutionError`。分类字段
//     （`timedOut` / `oversized` / `archived`）在这里标好，**要不要 handleTurnFailure 由调用方
//     按字段决定** —— 本模块不碰 pendingResets，也不往聊天里发任何提示（时序与拆分前一致：
//     提示与归档重建都留在调用点那侧）。
//   · 监听器在成功 / 失败 / 取消 / 超时四条路径上都摘除（原 A 的 cleanupListener、B 的 cleanup）。

import { visibleTextOf } from '../host/core/inbound-prep.js'

/**
 * 一个 DSH 回合的执行失败。
 *
 * 与拆分前一样「如实失败」：文案、超时阈值、413/归档的分类结果都带在错误上，调用方照旧决定
 * 记不记自愈标记、要不要 notify。`cause` 装的是原始失败对象（413 自愈要拿它的 message 记日志）。
 */
export class TurnExecutionError extends Error {
  /**
   * @param {string} message 错误文案。
   * @param {object} [meta] 分类元信息。
   * @param {string|null} [meta.kind] 回合落定原因（turn/end 的 reason.kind，或内部标记：cancelled/timedOut/followup/no-stream/…）。
   * @param {boolean} [meta.oversized] 是否按「请求体过大（413 / 插件内存上限）」处理。
   * @param {boolean} [meta.archived] 是否按「被归档门拦下（blocked）」处理。
   * @param {boolean} [meta.timedOut] 是否本地等待超时。
   * @param {number|null} [meta.timedOutForMs] 超时阈值（毫秒）。
   * @param {*} [meta.cause] 原始失败对象（可缺省）。
   */
  constructor(message, { kind = null, oversized = false, archived = false, timedOut = false, timedOutForMs = null, cause = undefined } = {}) {
    if (cause === undefined) super(message)
    else super(message, { cause })
    // 结构化字段：调用方按字段判定（不做 message 匹配，也不猜）。
    this.name = 'TurnExecutionError'
    this.kind = kind
    this.oversized = oversized
    this.archived = archived
    this.timedOut = timedOut
    this.timedOutForMs = timedOutForMs
  }
}

// 两种收集策略各自的文案（拆分前就是两套文案，这里按原样保留，不统一）。
//   timeoutMessage(seconds)：超时。
//   incompleteMessage(kind)：turn/end 非 completed。
//   streamMissingMessage：宿主没有 session/event 流。
//   followupMessage(message)：followup 阶段失败的包装（A 侧要套「DSH 回合执行失败：」，B 侧不套）。
const MODE_TEXT = {
  chat: {
    timeoutMessage: (seconds) => `DSH 回合超过 ${seconds} 秒未结束；已释放等待，迟到回复不会投递`,
    incompleteMessage: (kind) => `回合未正常结束：${kind || '?'}`,
    streamMissingMessage: 'DSH 没有 session/event 流，无法取回复文本',
    followupMessage: (message) => `DSH 回合执行失败：${message}`,
  },
  prompt: {
    timeoutMessage: (seconds) => `主动回合超过 ${seconds} 秒未结束`,
    incompleteMessage: (kind) => `主动回合未正常结束：${kind || '?'}`,
    streamMissingMessage: 'DSH 没有 session/event 流',
    followupMessage: (message) => message,
  },
}

/** 收集策略归一：mode 缺省按 chat（A 侧的老语义）。 */
function strategyFor(collect) {
  const mode = collect?.mode === 'prompt' ? 'prompt' : 'chat'
  return {
    mode,
    ...MODE_TEXT[mode],
    onToolCall: collect?.onToolCall,
    holdSettle: collect?.holdSettle,
    onFinish: collect?.onFinish,
  }
}

/** 取消错误：name 必须是 AbortError（turn-controller 用 `error?.name === 'AbortError'` 认「执行器尊重了取消」）。 */
function cancelledError() {
  const error = new TurnExecutionError('回合已被取消：DSH 回合执行中止，迟到回复不会再投递', { kind: 'cancelled' })
  error.name = 'AbortError'
  return error
}

/**
 * 回合执行器装配。
 *
 * @param {object} o 依赖。
 * @param {object} o.dsh DSH 上下文（`on` 取 session/event 流）。
 * @param {(name: string) => any} o.ctxGet 宿主服务取数（cordis 的 ctx.get）。
 * @param {() => object} o.getConfig 取配置（turnTimeoutMs）。
 * @param {object} [o.log] 日志器（本模块**不新增任何日志**，保留签名只为与其它子模块同形）。
 * @param {(m: string) => void} [o.debug] 调试日志（同上，本轮不使用：铁律「不改日志文本」）。
 * @param {(failure: object|string|null) => {oversized?: boolean, archived?: boolean}} o.classifyFailureKind
 *   回合失败分类器（host/core/turn-failure.js 的 classifyFailureKind）。**必须注入**：413 与归档门
 *   的自愈判定口径只允许有一处，本模块不自己写正则。
 * @param {(error: TurnExecutionError) => void} [o.onTimeout] 可选旁路观察钩子（超时）。不写标记、不发通知。
 * @param {(error: TurnExecutionError) => void} [o.onOversized] 可选旁路观察钩子（请求体过大）。
 * @param {(error: TurnExecutionError) => void} [o.onArchived] 可选旁路观察钩子（归档门 blocked）。
 * @returns {{runTurn: Function, resolveAgentFor: Function}}
 */
export function createTurnRunner({
  dsh, ctxGet, getConfig, log, debug, classifyFailureKind,
  onTimeout = null, onOversized = null, onArchived = null,
} = {}) {
  if (typeof classifyFailureKind !== 'function') throw new TypeError('createTurnRunner 需要 classifyFailureKind（回合失败分类）')
  void log
  void debug

  /**
   * 旁路观察钩子：只上报，不改变主链（钩子自己炸了也不许影响回合落定）。
   * 两个生产调用点都自己按 error 字段处理（要带 chatKey、要区分 notify），所以都不传 —— 保留注入位
   * 是为了 S3 收敛失败处理时不必再动装配根与签名。
   */
  const observe = (hook, error) => {
    if (typeof hook !== 'function') return
    try { hook(error) } catch { /* 观察钩子绝不影响回合 */ }
  }

  /**
   * resolveAgent → agent.followup 守卫（错误文案与聊天主链逐字一致）。
   *
   * @param {string} sessionId 会话 id。
   * @param {Array} [messages] 本轮要投喂的消息（当前 DSH 的 resolveAgent 只吃 sessionId：
   *   不往下传，免得改变适配器语义；保留入参让「按消息解析」的宿主不必改签名）。
   * @returns {Promise<object>} agent。
   */
  async function resolveAgentFor(sessionId, messages) {
    const ctrl = ctxGet('sessionController')
    if (!ctrl?.resolveAgent) throw new TurnExecutionError('DSH 没有 sessionController（新核心无法驱动会话）', { kind: 'no-session-controller' })
    const resolved = await ctrl.resolveAgent(sessionId)
    const agent = resolved?.agent
    if (!agent?.followup) throw new TurnExecutionError(`会话 ${sessionId} 没有 agent.followup（适配缺口，如实失败）`, { kind: 'no-followup' })
    void messages
    return agent
  }

  /**
   * `turn/end` 与非 completed 的失败分类：只认注入的分类器。
   * 显式取字段（不是 spread 一个 Error：Error 的 message 不可枚举，spread 会丢），
   * 顺带把 kind 与原始 error 一并给进去 —— `blocked` 没有 error 细节，只能认 kind。
   *
   * @param {string|undefined} kind turn/end 的 reason.kind。
   * @param {object|null} failure reason.error / reason.failure。
   * @returns {{oversized: boolean, archived: boolean}}
   */
  function failureFlags(kind, failure) {
    const probe = failure && typeof failure === 'object'
      ? { code: failure.code, status: failure.status, message: failure.message, kind, error: failure }
      : { kind }
    let classified = null
    try { classified = classifyFailureKind(probe) } catch { classified = null }
    return { oversized: Boolean(classified?.oversized), archived: Boolean(classified?.archived) }
  }

  /**
   * 跑一个回合，返回 `{ text, completion }`；失败抛 `TurnExecutionError`。
   *
   * @param {object} o 入参。
   * @param {string} o.sessionId 会话 id（事件按 session.id 过滤）。
   * @param {object} o.message 完整形状的 user 消息（`{ id, role, content, source.kind }`）。
   * @param {object} o.collect 文本收集策略：`{ mode, onToolCall?, holdSettle?, onFinish? }`。
   * @param {AbortSignal|null} [o.signal] 取消信号（null = 这条路没有取消语义）。
   * @param {object|null} [o.agent] 调用方已解析的 agent（聊天主链要在 followup 之前把工具/上下文/
   *   模型挂到**同一份包装对象**上，不能二次 resolve —— 宿主每轮都返回新的包装对象）。
   * @returns {Promise<{text: string, completion: object}>} 回合文本与落定信息。
   */
  async function runTurn({ sessionId, message, collect = {}, signal = null, agent: resolvedAgent = null, turnState = null } = {}) {
    const strategy = strategyFor(collect)
    const agent = resolvedAgent || await resolveAgentFor(sessionId, [message])
    if (signal?.aborted) {
      try { Promise.resolve(agent.cancel?.({ kind: 'user' })).catch(() => {}) } catch { /* 取消失败不影响落定 */ }
      throw cancelledError()
    }

    const timeoutMs = Math.max(1, Number(getConfig().turnTimeoutMs) || 600_000)
    let off = null
    let timer = null
    let abortHandler = null
    let followupFinished = false
    /** @type {null|{completed: boolean, kind: string|undefined, text: string, failure: any, oversized: boolean, archived: boolean}} */
    let completion = null
    /** 收尾函数（finishReply）：事件机内部定义，回合落定后由这里/调用方驱动。 */
    let settle = null

    /** 摘监听 + 清定时器 + 解绑 abort：所有路径（成功/失败/超时/取消）都走这里。 */
    const cleanup = () => {
      try { off?.() } catch { /* 摘监听失败不影响落定 */ }
      off = null
      if (timer) { clearTimeout(timer); timer = null }
      if (signal && abortHandler) {
        try { signal.removeEventListener('abort', abortHandler) } catch { /* 已解绑 */ }
      }
      abortHandler = null
    }

    // 让宿主把这一回合真正停掉：否则「已释放等待」的回合还在后台生成，白烧 token 也白占槽。
    const cancelAgent = () => {
      try { Promise.resolve(agent.cancel?.({ kind: 'user' })).catch(() => {}) } catch { /* 取消失败不影响落定 */ }
    }

    // 超时：内部自己建 Promise（timer unref，绝不撑住进程退出）。默认 10 分钟，配置可覆盖。
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        cancelAgent()
        const error = new TurnExecutionError(strategy.timeoutMessage(Math.ceil(timeoutMs / 1000)), {
          kind: 'timedOut', timedOut: true, timedOutForMs: timeoutMs,
        })
        observe(onTimeout, error)
        reject(error)
      }, timeoutMs)
      timer.unref?.()
    })
    // 只防「另一个 race 已先落定」时的进程级 unhandledRejection（不影响 race 本身的结果）。
    timeoutPromise.catch(() => {})

    // 取消：signal 绑 abort；触发时以 AbortError 身份结束（turn-controller 据此诚实落 cancelled）。
    let abortPromise = null
    if (signal) {
      abortPromise = new Promise((resolve, reject) => {
        abortHandler = () => { cancelAgent(); reject(cancelledError()) }
        signal.addEventListener('abort', abortHandler, { once: true })
      })
      abortPromise.catch(() => {})
    }

    const replyPromise = new Promise((resolve, reject) => {
      let done = false
      // T3.2：向调用方暴露「本轮还能不能 steer」。turn/end 收尾（finish）或 cleanup 后为 false：
      // 调用方在异步水合/看图之后、真正调 agent.steer 之前必须复查，否则会把孤儿 steer
      // 投给已经 idle 的 agent（用户追问静默丢失）。
      if (turnState && typeof turnState === 'object') {
        // 「已结束」= 收到 turn/end（completion 已置）或已 settle/cleanup（done）。
        // 注意不能用 done 单判：collect.holdSettle 在活跃 steer 未落定时会故意压住收尾，
        // 那一刻 turn/end 其实已经到了，再 steer 就是孤儿。
        const ended = () => done || completion !== null
        turnState.isTurnEnded = ended
        turnState.canSteer = () => !ended()
      }
      // 本轮 turn 号（turn/start 给出）：用来拒绝旧轮迟到的 assistant/message 与 turn/end 串台。
      let activeTurn = null
      let lastTurn = null
      let lastText = ''
      let lastStepHasToolCall = false
      // 同回合里被 steer（新 user/message）隔开的完整回复段（chat 专用）：
      // 真实 DSH 的 agent.steer() 不会中断正在生成的 step，而是等 step 1 正常定稿（无 tool-call）后，
      // 在同一个 turn 里插入 user/message 跑 step 2。模型在 step 2 里默认对方已看到 step 1，
      // 如果只取 lastText 会把 step 1 整段吞掉（真机 2026-11-26 12:51）。
      let committedReplies = []
      // 本段每一「步」的定稿文本（按 step 顺序）。末步只剩控制标记时用它兜底：
      // agent 回合里「写了正文又调工具」的那一步，正文会随着工具结果进入下一步，
      // 而末步往往只补一句标记收尾（真机 2026-11-23 15:01 就是这种形状）。
      let stepTexts = []
      const isSilenceMarker = (text) => /^\[沉默\]$/.test(visibleTextOf(text).trim())
      /** 解析当前段文本：末步没有人话时，回退到本段上一条带人话的步（保留末步的控制标记，如表情）。 */
      const resolveSegmentText = () => {
        const raw = String(lastText || '')
        if (visibleTextOf(raw)) return raw
        for (let i = stepTexts.length - 2; i >= 0; i -= 1) {
          const plain = visibleTextOf(stepTexts[i])
          if (plain) return `${plain}\n${raw}`.trim()
        }
        return raw
      }
      const resolveTurnText = () => {
        const tail = resolveSegmentText()
        if (!committedReplies.length) return tail
        const parts = [...committedReplies]
        if (tail.trim() && !isSilenceMarker(tail)) parts.push(tail)
        return parts.join('|||')
      }
      /**
       * 收尾（原 A 的 finishReply / 原 B 的 turn/end 分支）：
       * 只有拿到 turn/end 才收尾；chat 还要等 followup 兑现与活跃 steer 落定（原 A 的
       * `if (followupDone && !activeSteers)` 两闸），prompt 在 turn/end 当刻就收尾（原 B 语义）。
       */
      const finish = () => {
        if (done || !completion) return
        if (strategy.mode === 'chat' && !followupFinished) return
        if (strategy.holdSettle?.()) return
        done = true
        cleanup()
        if (!completion.completed) {
          const error = new TurnExecutionError(strategy.incompleteMessage(completion.kind), {
            kind: completion.kind,
            oversized: completion.oversized,
            archived: completion.archived,
            cause: completion.failure,
          })
          if (completion.oversized) observe(onOversized, error)
          if (completion.archived) observe(onArchived, error)
          reject(error)
          return
        }
        resolve(completion.text)
      }
      settle = finish
      // chat：把收尾函数交给调用方（活跃 steer 落定后由 execute 驱动，同拆分前的 finishReply 变量）
      strategy.onFinish?.(finish)

      off = dsh.on?.('session/event', (session, ev) => {
        if (session?.id !== sessionId) return
        if (ev?.type === 'turn/start') {
          if (ev?.data?.turn !== undefined) activeTurn = ev.data.turn
          return
        }
        if (ev?.type === 'tool/call') {
          // 主动回合只要正文：工具调用不参与收集，也没有报告标记（原 B 语义）。
          if (strategy.mode !== 'chat') return
          lastStepHasToolCall = true
          strategy.onToolCall?.(ev)
          return
        }
        if (ev?.type === 'user/message') {
          if (strategy.mode !== 'chat') return
          // runtime-context 是宿主上下文投影，不算用户中途 steer 进来的新消息
          const source = ev?.data?.source?.kind
          if (source !== 'runtime-context' && lastTurn !== null && lastText && !lastStepHasToolCall) {
            const segment = resolveSegmentText()
            if (segment.trim() && !isSilenceMarker(segment)) committedReplies.push(segment)
            lastText = ''
            stepTexts = []
            lastStepHasToolCall = false
          }
          return
        }
        if (ev?.type === 'assistant/message') {
          const d = ev?.data || {}
          if (d.interrupted) return
          // 已见过 turn/start 时只认本轮消息：上一轮迟到的 assistant/message 混进来会把正文写串
          if (activeTurn !== null && d.turn !== undefined && d.turn !== activeTurn) return
          if (strategy.mode !== 'chat') {
            // 主动回合：只留最后一条有正文的 assistant/message（原 B 逐行等价）
            const value = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
            if (value) { lastTurn = d.turn; lastText = value }
            return
          }
          const blocks = Array.isArray(d.message?.content) ? d.message.content : []
          const hasToolCall = blocks.some((c) => c && (c.type === 'tool-call' || c.type === 'tool_call' || c.type === 'tool_use'))
          const text = blocks.filter((c) => c.type === 'text').map((c) => c.text).join('')
          if (d.turn !== lastTurn) {
            lastTurn = d.turn
            lastText = ''
            stepTexts = []
            committedReplies = []
            lastStepHasToolCall = false
          }
          lastStepHasToolCall = hasToolCall
          if (text) {
            lastText = text
            stepTexts.push(text)
          }
          return
        }
        if (ev?.type === 'turn/end') {
          // 不在这里清任何标记：投递发生在 turn/end 之后（报告兜底标记由调用方持有）。
          const d = ev?.data || {}
          // 绑定本轮 turn 号：见过 turn/start 时只认本轮 turn/end（旧轮迟到的一律忽略，不当时本轮完成）；
          // 宿主/夹具没发 turn/start 时退化为「只挡旧轮」——d.turn 比本轮最后一条正文更旧才忽略，
          // 更新的 turn/end 仍按原口径收尾（下面 sameTurn 校验保证旧正文不会当成本轮回复返回）。
          if (activeTurn !== null && d.turn !== undefined && d.turn !== activeTurn) return
          if (activeTurn === null && lastTurn !== null && d.turn !== undefined) {
            const incoming = Number(d.turn)
            const seen = Number(lastTurn)
            if (Number.isFinite(incoming) && Number.isFinite(seen) && incoming < seen) return
          }
          const kind = d.reason?.kind
          const failure = d.reason?.error || d.reason?.failure || null
          const { oversized, archived } = failureFlags(kind, failure)
          const sameTurn = lastTurn === d.turn
          completion = {
            completed: kind === 'completed',
            kind,
            text: sameTurn ? (strategy.mode === 'prompt' ? String(lastText || '') : resolveTurnText()) : '',
            failure,
            oversized,
            archived,
          }
          finish()
        }
      })
      if (typeof off !== 'function') {
        off = null
        cleanup()
        reject(new TurnExecutionError(strategy.streamMissingMessage, { kind: 'no-stream' }))
      }
    })
    // replyPromise 可能先于等待者落定（例如事件流缺失 + followup 随后拒绝）：挂一个吞掉的处理器，
    // 避免进程级 unhandledRejection（race 仍然拿到真实拒绝）。
    replyPromise.catch(() => {})

    // 阶段 1：followup（与超时/取消赛跑）。原 A 的 rejected promise 必须捕获，
    // 否则 unhandledRejection + 回合永久 running 占死该聊天调度槽。
    let followupError = null
    try {
      const racers = [agent.followup(message), timeoutPromise]
      if (abortPromise) racers.push(abortPromise)
      await Promise.race(racers)
    } catch (error) {
      followupError = error
    }
    followupFinished = true
    if (followupError) {
      cleanup() // 失败路径同样摘监听（报告 §4.5「finally 清理监听」）
      // 取消原样抛（name 必须保持 AbortError）；超时补上本侧文案；followup 自身拒绝则按 A 侧口径包装。
      if (followupError instanceof TurnExecutionError && followupError.kind === 'cancelled') throw followupError
      if (followupError instanceof TurnExecutionError && followupError.timedOut) {
        throw new TurnExecutionError(strategy.followupMessage(followupError.message), {
          kind: followupError.kind, timedOut: true, timedOutForMs: followupError.timedOutForMs,
        })
      }
      const failure = followupError?.failure || followupError
      // 与 #263 对齐：followup 直接拒绝也可能带 kind === 'blocked'（宿主归档门在 pre-step 就把这一回合
      // 拒了，一个模型调用都没发生）。#263 在 followupError 出口专门认过这一条；这里同样要把 kind
      // 交给分类器，否则只判 oversized 会把它悄悄归成「普通失败」，下一条消息还指着已归档会话。
      const { oversized, archived } = failureFlags(followupError?.kind ?? failure?.kind ?? null, failure)
      const error = new TurnExecutionError(strategy.followupMessage(followupError?.message || String(followupError)), {
        kind: 'followup', oversized, archived, cause: failure,
      })
      if (oversized) observe(onOversized, error)
      if (archived) observe(onArchived, error)
      throw error
    }
    // followup 已兑现：turn/end 早到的那种形状（真机/夹具都会）此刻补收尾
    settle?.()

    // 阶段 2：等 turn/end 收尾（chat 的分段拼接也在这一步定稿）
    try {
      const racers = [replyPromise, timeoutPromise]
      if (abortPromise) racers.push(abortPromise)
      const text = await Promise.race(racers)
      cleanup()
      return {
        text,
        completion: {
          completed: Boolean(completion?.completed),
          kind: completion?.kind ?? null,
          failure: completion?.failure ?? null,
          oversized: Boolean(completion?.oversized),
          archived: Boolean(completion?.archived),
        },
      }
    } catch (error) {
      cleanup()
      throw error
    }
  }

  return { runTurn, resolveAgentFor }
}