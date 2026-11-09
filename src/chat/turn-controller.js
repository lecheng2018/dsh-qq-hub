// M2-C · Turn Controller：回合生命周期 + 合流窗口 + steer/取消（纯模块，注入 execute 即可全测）
//
// 语义（任务书 M2-C + 旧 aggregator 的五条恢复前置——在**新设计**里全部成立，不恢复旧吞并实现）：
//   1. 每聊天串行、跨聊天并行（scheduler 承担）；
//   2. 合流窗口：lead 进 merging 态开窗；成员加入则续窗（有 maxMs 上限，timer generation 防旧钟）；
//   3. lead 取消不销毁 follower：merging 态整回合取消时，其余成员各自作为新 lead 重新开回合（事件不丢）；
//   4. flush 与 in-flight 无空档：窗口结束的回合经 scheduler 排队，running 未完绝不并发，完场立即接续；
//   5. 异常唤醒所有等待者：execute 抛错 → 该回合 failed、排队与 steer 等待全部以错误唤醒；
//   6. steer：running 态的回合收到新输入 = 转向（计入成员、交给 execute 的 onSteer）；
//      merging 态收到输入 = 普通加入成员；
//   7. 取消诚实标记（ADR 红线）：cancel 只是**请求**——running 态通过注入的 signal 通知 execute，
//      能否真正取消由 DSH 适配器如实决定；controller 不谎报「已取消」，
//      只有 execute 以取消原因落定后 state 才是 cancelled（cancelRequestedAt 恒留痕）。
//   8. dispose：清所有窗口定时器、取消全部回合、排队任务与 steer 等待者全部唤醒，绝不留句柄。

import { createTurn, setTurnState, addMember, addSteerMember, isTerminal } from './turn-state.js'
import { createTurnScheduler } from './turn-scheduler.js'
import { parseChatKey } from './chat-key.js'

const DEFAULT_MERGE = Object.freeze({ waitMs: 2500, maxMs: 8000, groupWaitMs: 5000, groupMaxMs: 15000 })

/**
 * @param {object} o
 * @param {(turn: object, io: { members: Array, signal: AbortSignal, onSteer: (inbound) => Promise<void> }) => Promise<*>} o.execute
 *   真正执行一个回合的注入点（DSH 适配器 / 测试桩）。execute 内部应尊重 signal（能取消就取消）。
 * @param {{waitMs?:number, maxMs?:number, groupWaitMs?:number, groupMaxMs?:number}} [o.merge] 合流窗口参数
 * @param {() => number} [o.now] 时间注入（测试用）
 */
export function createTurnController({ execute, merge = {}, log } = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute 必须是函数')
  const m = { ...DEFAULT_MERGE, ...merge }
  const scheduler = createTurnScheduler()

  /** turnId -> turn */
  const turns = new Map()
  /** chatKey -> { mergingTurnId, timer, generation } */
  const windows = new Map()
  /** turnId -> { steers: [...], closed }（running 态的 steer 挂起） */
  const live = new Map()
  /** chatKey -> running turnId（steer 定位用） */
  const runningByChat = new Map()
  let disposed = false

  const debug = (msg) => { try { log?.debug?.(msg) } catch {} }
  // 缺陷 7：flushTurn 失败此前被 `.catch(() => {})` 完全吞掉——任何回合失败零日志，排查全靠猜。留痕（不改变吞异常语义，只补可观测性）。
  const flushFail = (turn, error) => { try { log?.warn?.(`回合执行失败：${turn?.chatKey} ${turn?.turnId}：${error?.message || error}`) } catch {} }

  function windowFor(chatKey) {
    let w = windows.get(chatKey)
    if (!w) {
      w = { mergingTurnId: null, timer: null, generation: 0 }
      windows.set(chatKey, w)
    }
    return w
  }

  function windowParams(chatKey) {
    return parseChatKey(chatKey).kind === 'group'
      ? { waitMs: m.groupWaitMs, maxMs: m.groupMaxMs }
      : { waitMs: m.waitMs, maxMs: m.maxMs }
  }

  function clearTimer(chatKey, w) {
    if (w.timer) {
      clearTimeout(w.timer)
      w.timer = null
      w.generation++ // 旧定时器作废（timer generation：迟到回调按代数自检，不误触发新回合）
    }
  }

  /** 落定一个 running 回合（统一收口：状态、等待者唤醒、live 清理、队列接续）。 */
  function settleRunning(turn, error, cancelled) {
    const l = live.get(turn.turnId)
    if (l) l.closed = true
    if (error) {
      turn.error = String(error?.message || error)
      try { setTurnState(turn, cancelled ? 'cancelled' : 'failed') } catch { /* 已终态则保底 */ if (!isTerminal(turn)) throw error }
    } else {
      try { setTurnState(turn, 'succeeded') } catch { /* 同上 */ }
    }
    live.delete(turn.turnId)
    if (runningByChat.get(turn.chatKey) === turn.turnId) runningByChat.delete(turn.chatKey)
    // steer 等待者：回合结束，全部按结果唤醒（失败/取消→reject 同错误）
    if (l) {
      for (const s of l.pendingSteers) cancelled || error ? s.reject(error || new Error('回合已取消')) : s.resolve()
    }
    debug(`回合 ${turn.state}：${turn.chatKey} 成员 ${turn.memberEventIds.length} 条${error ? '（' + turn.error + '）' : ''}`)
  }

  /** 窗口到期 / 立即 flush：merging → 排队执行（经 scheduler 与在飞回合串行）。 */
  function flushTurn(turn) {
    const w = windowFor(turn.chatKey)
    if (w.mergingTurnId === turn.turnId) {
      w.mergingTurnId = null
      if (w.timer) { clearTimeout(w.timer); w.timer = null }
    }
    setTurnState(turn, 'pending')
    const liveEntry = { steerHandler: null, pendingSteers: [], buffered: [], closed: false }
    live.set(turn.turnId, liveEntry)
    const abort = new AbortController()
    turn.cancelSignal = abort.signal
    /** 注册转向处理器；注册前已到达的转向输入按序补投递（busy steer 语义）。 */
    const registerSteer = (handler) => {
      if (typeof handler !== 'function') throw new TypeError('onSteer 需要一个 handler 函数')
      liveEntry.steerHandler = handler
      while (liveEntry.buffered.length) {
        const item = liveEntry.buffered.shift()
        Promise.resolve().then(() => handler(item)).then(item.resolve, item.reject)
      }
    }
    const deliverSteer = (inbound) => new Promise((resolve, reject) => {
      if (disposed || liveEntry.closed) return reject(new Error('回合已结束，转向输入无效'))
      if (isTerminal(turn)) return reject(new Error('回合已结束，转向输入无效'))
      // 双保险：ChatKey 不变量（steer 入口已查；这里兜住任何直接持有 deliverSteer 的调用方）
      if (String(inbound?.chatKey ?? '') !== turn.chatKey) return reject(new Error(`转向输入 ChatKey 与回合不一致：${inbound?.chatKey} ≠ ${turn.chatKey}`))
      addSteerMember(turn, inbound)
      turn.steerCount++
      if (liveEntry.steerHandler) {
        Promise.resolve().then(() => liveEntry.steerHandler(inbound)).then(resolve, reject)
      } else {
        liveEntry.pendingSteers.push({ resolve, reject })
        liveEntry.buffered.push(inbound) // execute 还没注册：缓存，注册时补投
      }
    })
    const io = {
      members: turn.members.slice(),
      signal: abort.signal,
      onSteer: registerSteer,
    }
    turn._abort = abort
    turn._deliverSteer = deliverSteer
    const job = async () => {
      if (disposed) throw new Error('controller 已卸载（dispose 排队任务）')
      // 排队期间已被取消：出队直接跳过执行并清理 steer 现场（旧实现照跑 execute，
      // 忽略 signal 的执行器甚至把它落 succeeded——谎报）。
      if (isTerminal(turn)) {
        const l = live.get(turn.turnId)
        if (l) {
          l.closed = true
          for (const s of l.pendingSteers) s.reject(new Error('回合已取消'))
          live.delete(turn.turnId)
        }
        return null
      }
      setTurnState(turn, 'running')
      runningByChat.set(turn.chatKey, turn.turnId)
      try {
        const result = await execute(turn, io)
        settleRunning(turn, null, false)
        return result
      } catch (error) {
        const cancelled = abort.signal.aborted || error?.name === 'AbortError' || turn.cancelRequestedAt != null
        settleRunning(turn, error, cancelled)
        throw error
      }
    }
    return scheduler.submit(turn.chatKey, job)
  }

  /** 取消 merging 态回合：lead 消失，但 follower 不销毁——各自重新作为 lead 开新回合。 */
  function cancelMerging(turn) {
    const w = windowFor(turn.chatKey)
    if (w.mergingTurnId === turn.turnId) clearTimer(turn.chatKey, w)
    const followers = turn.members.slice(1)
    setTurnState(turn, 'cancelled')
    // 终态记录保留在 turns 里（可查证 cancelled），不删——getTurn 要能回答「它被取消了」
    for (const f of followers) {
      if (!f) continue
      offer(f) // 事件不丢：follower 自己当 lead 重开窗口
    }
  }

  /**
   * 投递一条入站事件。
   * @returns {{role:'lead'|'follower'|'steer', turnId:string}}
   */
  function offer(inbound) {
    if (disposed) throw new Error('controller 已卸载')
    parseChatKey(inbound.chatKey)
    const chatKey = inbound.chatKey

    // running 态有回合 → steer（转向）；无 merging 窗 → steer 挂起等待在飞回合消费
    // （简化且诚实：steer 的判定交给调用方在 inbound 带上 steer 标记；这里 offer 默认只走合流）
    const w = windowFor(chatKey)
    if (w.mergingTurnId) {
      const turn = turns.get(w.mergingTurnId)
      if (turn && turn.state === 'merging') {
        const { waitMs, maxMs } = windowParams(chatKey)
        addMember(turn, inbound)
        // 续窗：从现在起再等 waitMs，但总窗不超过 maxMs（timer generation 防旧钟）
        const elapsed = Date.now() - turn.createdAt
        const remain = Math.max(0, Math.min(waitMs, maxMs - elapsed))
        clearTimer(chatKey, w)
        w.mergingTurnId = turn.turnId
        const gen = w.generation
        w.timer = setTimeout(() => {
          if (w.generation !== gen || w.mergingTurnId !== turn.turnId) return
          flushTurn(turn).catch((error) => flushFail(turn, error))
        }, remain)
        w.timer.unref?.()
        return { role: 'follower', turnId: turn.turnId }
      }
    }

    const turn = createTurn({ chatKey, memberEventId: inbound.eventId, createdAt: null })
    turn.members[0] = inbound
    turns.set(turn.turnId, turn)
    const { waitMs, maxMs } = windowParams(chatKey)
    w.mergingTurnId = turn.turnId
    const gen = w.generation
    w.timer = setTimeout(() => {
      if (w.generation !== gen || w.mergingTurnId !== turn.turnId) return
      flushTurn(turn).catch((error) => flushFail(turn, error))
    }, Math.min(waitMs, maxMs))
    w.timer.unref?.()
    return { role: 'lead', turnId: turn.turnId }
  }

  /**
   * 转向：把一条输入作为 running 回合的 steer 注入。
   * @returns {Promise<void>} 回合内被消费时 resolve；无 running 回合时抛错（调用方应改走 offer）
   */
  async function steer(turnId, inbound) {
    const turn = turns.get(turnId)
    if (!turn) throw new Error(`没有这个回合：${turnId}`)
    if (turn.state !== 'running') throw new Error(`回合不在 running 态（${turn.state}），请改走 offer`)
    // ChatKey 不变量（报告 §4.7）：转向输入必须与回合同聊天域，否则 private 回合会被
    // group 事件（反之亦然）污染成员/上下文。
    if (String(inbound?.chatKey ?? '') !== turn.chatKey) {
      throw new Error(`转向输入的 ChatKey 与回合不一致：${inbound?.chatKey} ≠ ${turn.chatKey}`)
    }
    const deliver = turn._deliverSteer
    if (!deliver) throw new Error('回合执行现场不存在')
    await deliver(inbound)
  }

  /**
   * 请求取消一个回合。
   * @returns {{honest: 'cancelled-immediately'|'cancel-requested'|'unknown-turn'}}
   *   cancelled-immediately：merging/pending（还没跑）——立即终态，follower 重开回合；
   *   cancel-requested：running——已向 execute 发出 abort 信号，最终态以 execute 落定为准（诚实标记）。
   */
  function cancel(turnId) {
    const turn = turns.get(turnId)
    if (!turn || isTerminal(turn)) return { honest: 'unknown-turn' }
    turn.cancelRequestedAt = Date.now()
    if (turn.state === 'merging') {
      cancelMerging(turn)
      return { honest: 'cancelled-immediately' }
    }
    if (turn.state === 'pending') {
      // 排队未跑：直接落终态（还没发生副作用，诚实可标 cancelled），follower 事件重开为新 lead。
      // 排队 job 出队时用 isTerminal 检查跳过执行——不再照跑 execute 甚至谎报 succeeded。
      setTurnState(turn, 'cancelled')
      const l = live.get(turn.turnId)
      if (l) l.closed = true
      const followers = turn.members.slice(1)
      for (const f of followers) {
        if (!f) continue
        offer(f) // 事件不丢
      }
      return { honest: 'cancelled-immediately' }
    }
    if (turn.state === 'running') {
      turn._abort?.abort(new Error('回合被取消'))
      return { honest: 'cancel-requested' }
    }
    return { honest: 'unknown-turn' }
  }

  /** 只读回合视图（面板/诊断/测试）。 */
  function getTurn(turnId) {
    const t = turns.get(turnId)
    return t ? { ...t, members: undefined, cancelSignal: undefined, _abort: undefined } : null
  }

  /** 是否有窗口在收成员（测试视图）。 */
  function mergingTurnOf(chatKey) {
    const w = windows.get(chatKey)
    return w?.mergingTurnId ?? null
  }

  /** 该聊天当前 running 的回合（无则 null；steer 定位用）。 */
  function runningTurnOf(chatKey) {
    return runningByChat.get(chatKey) ?? null
  }

  /** 卸载：清定时器、merging 全取消、在飞 execute 收到 abort（诚实标记后自然落定）、等待者全部唤醒。 */
  async function dispose() {
    disposed = true
    for (const [chatKey, w] of windows) {
      clearTimer(chatKey, w)
      if (w.mergingTurnId) {
        const turn = turns.get(w.mergingTurnId)
        if (turn && turn.state === 'merging') {
          try { setTurnState(turn, 'cancelled') } catch {}
        }
      }
    }
    windows.clear()
    for (const [turnId, l] of live) {
      l.closed = true
      for (const s of l.pendingSteers) s.reject(new Error('controller 已卸载（steer 等待唤醒）'))
      const turn = turns.get(turnId)
      if (turn && turn.state === 'pending') {
        // 被 dispose 清出队列的排队回合：scheduler.dispose 会 reject 它的 job，但 job 在
        // 到达 isTerminal 检查前就抛“已卸载”——回合记录会永久停在 pending（P2 复核）。
        // 这里直接落终态，保证 getTurn 可查证、不留 pending。
        try { setTurnState(turn, 'cancelled') } catch {}
      } else if (turn && turn.state === 'running') {
        turn.cancelRequestedAt = Date.now()
        turn._abort?.abort(new Error('controller 已卸载'))
      }
    }
    // 回合记录保留（终态可查证）；结构随 controller 一起消亡，无需手动清
    await scheduler.dispose()
  }

  return { offer, steer, cancel, getTurn, mergingTurnOf, runningTurnOf, dispose }
}
