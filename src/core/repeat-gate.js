// 重复日志去重闸（纯函数式小工具，注入 now 便于测试）。
//
// 背景（真机 2026-11-14 主人反馈）：「群闸：不回 —— 插话关着」「入站 ACL 拒绝：不在群白名单」
// 这类**逐条重复的否定判定**把面板日志刷到没法看。但直接不打又丢排查线索
// （比如「她什么时候开始不回这个群的」）。
//
// 策略：按会话一个键，把「判定内容」当签名——
//   · 签名变化（第一次出现 / 理由换了）→ 立刻放行：状态转变恰恰是想知道的；
//   · 同款判定 → 窗口内全沉默，攒着计数；
//   · 距上次放行满一个窗口 → 放行一条并附上「已静默 N 条」，相当于周期心跳。
// 最吵的场景（一个群每几秒一条、理由恒定）从「每条目不线」压成「每窗口一条」。
//
// 容量兜底：会话键有上限，超了驱逐最久没放行的 —— 日志去重器自己不能变成内存泄漏。

/**
 * @param {object} [o]
 * @param {number} [o.windowMs] 同款判定的汇总周期（默认 5 分钟）
 * @param {number} [o.maxKeys]  同时跟踪的会话键上限（默认 200）
 * @param {() => number} [o.nowFn] 注入时钟（测试用）
 * @returns {(gateKey: string, sig: string) => {emit: boolean, suppressed: number}}
 *   调用一次 = 有一条候选日志。emit=true 时应打出这行；suppressed 是本次之前被
 *   静默掉的同款条数（>0 时调用方应把它拼进文案，让读日志的人知道中间压了多少）。
 */
export function createRepeatGate({ windowMs = 300_000, maxKeys = 200, nowFn = () => Date.now() } = {}) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : 300_000
  const seen = new Map() // gateKey → { sig, count, lastEmitAt }
  return function check(gateKey, sig) {
    const key = String(gateKey || '')
    if (!key) return { emit: true, suppressed: 0 } // 没键就没去重：宁可多打，不能吞日志
    const now = Number(nowFn()) || Date.now()
    const rec = seen.get(key)
    if (!rec || rec.sig !== sig) {
      // 首次 / 判定变了：放行。键位不够就先驱逐最旧的一个。
      if (!rec && seen.size >= maxKeys) {
        let oldestKey = null
        let oldest = Infinity
        for (const [k, v] of seen) {
          if (v.lastEmitAt < oldest) { oldest = v.lastEmitAt; oldestKey = k }
        }
        if (oldestKey != null) seen.delete(oldestKey)
      }
      seen.set(key, { sig, count: 0, lastEmitAt: now })
      return { emit: true, suppressed: 0 }
    }
    if (now - rec.lastEmitAt >= win) {
      // 心跳放行：suppressed 只报「此前静默掉的」，当前这条是被放行的，不重复计数
      const suppressed = rec.count
      rec.count = 0
      rec.lastEmitAt = now
      return { emit: true, suppressed }
    }
    rec.count += 1
    return { emit: false, suppressed: rec.count }
  }
}
