// M2-C · Turn Scheduler：每聊天串行、跨聊天并行的执行闸（纯模块）
//
// 职责只有一个：同一 chatKey 同时最多一个 job 在跑，其余排队（FIFO）；
// 不同 chatKey 互不阻塞。异常/完成都会唤醒队列（无空档）。
// dispose：清空排队（以 dispose 错误唤醒）+ 等待在飞 job 落定。

export function createTurnScheduler({ maxQueue = 50 } = {}) {
  /** chatKey -> { running: Promise|null, queue: [ {job, resolve, reject} ] } */
  const lanes = new Map()
  let disposed = false
  const limit = Math.max(1, Math.floor(Number(maxQueue) || 50))

  function lane(chatKey) {
    let l = lanes.get(chatKey)
    if (!l) {
      l = { running: null, queue: [] }
      lanes.set(chatKey, l)
    }
    return l
  }

  function pump(chatKey) {
    const l = lane(chatKey)
    if (l.running || disposed) return
    const next = l.queue.shift()
    if (!next) {
      if (!l.running && l.queue.length === 0) lanes.delete(chatKey)
      return
    }
    l.running = (async () => {
      try {
        if (disposed) return next.reject(new Error('scheduler 已卸载'))
        const result = await next.job()
        next.resolve(result)
      } catch (error) {
        next.reject(error)
      } finally {
        l.running = null
        pump(chatKey)
      }
    })()
  }

  /**
   * 提交一个 job 到该聊天的串行道。
   * @returns {Promise<*>} job 的完成结果（排队期间 dispose → reject 'scheduler 已卸载'）
   */
  function submit(chatKey, job) {
    if (disposed) return Promise.reject(new Error('scheduler 已卸载'))
    if (typeof job !== 'function') return Promise.reject(new TypeError('job 必须是函数'))
    const l = lane(chatKey)
    if (l.queue.length >= limit) return Promise.reject(new Error(`queue full: ${chatKey} 排队已达到 ${limit} 个任务`))
    return new Promise((resolve, reject) => {
      l.queue.push({ job, resolve, reject })
      pump(chatKey)
    })
  }

  /** 该聊天是否有 job 在跑（测试/诊断视图）。 */
  function isBusy(chatKey) {
    return Boolean(lanes.get(chatKey)?.running)
  }

  /** 排队长度（测试视图）。 */
  function queuedCount(chatKey) {
    return lanes.get(chatKey)?.queue.length ?? 0
  }

  /** 卸载：排队的全部以卸载错误唤醒；在飞的等它自然落定。 */
  async function dispose() {
    disposed = true
    const pending = []
    for (const [chatKey, l] of lanes) {
      for (const item of l.queue.splice(0)) {
        item.reject(new Error('scheduler 已卸载（dispose 排队任务）'))
      }
      if (l.running) pending.push(l.running.catch(() => {}))
    }
    lanes.clear()
    await Promise.all(pending)
  }

  return { submit, isBusy, queuedCount, dispose }
}
