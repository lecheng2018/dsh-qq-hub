// 群发送配额：QQ 群有「每分钟最多 N 条」的硬限制（实测 N=10，被拒时返回 result=299）。
// 超了以后网关直接拒绝，消息**真的丢了**（2026-11-04 实测：她一轮发 3 条，2 条被拒没发出去，
// 而 chatlog 记的是「尝试发送的内容」，所以日志里看不出来丢过）。
//
// 这一层做两件事：
//   ① 预防：发之前先看本群最近 60 秒发了几条，快满就等窗口滑过去；
//   ② 兜底：万一还是被拒（别的客户端也在发、网关口径不同），等到下一个窗口重试一次。
//
// 纯本地状态，不碰网络；调用方传入 send / sleep 便于测试。

export const GROUP_QUOTA_DEFAULT = Object.freeze({
  enabled: true,
  perMinute: 10,        // QQ 群每分钟上限
  reserve: 1,           // 留一条余量给 @/追问这类必须发出去的
  windowMs: 60_000,
  retryWaitMs: 65_000,  // 被拒后等多久重试（跨过一个完整窗口）
  maxRetries: 1,
})

const asBool = (v, d) => (typeof v === 'boolean' ? v : d)
const clampInt = (v, d, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
}

export function normalizeGroupQuota(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: asBool(src.enabled, GROUP_QUOTA_DEFAULT.enabled),
    perMinute: clampInt(src.perMinute, GROUP_QUOTA_DEFAULT.perMinute, 1, 200),
    reserve: clampInt(src.reserve, GROUP_QUOTA_DEFAULT.reserve, 0, 10),
    windowMs: clampInt(src.windowMs, GROUP_QUOTA_DEFAULT.windowMs, 10_000, 10 * 60_000),
    retryWaitMs: clampInt(src.retryWaitMs, GROUP_QUOTA_DEFAULT.retryWaitMs, 1_000, 5 * 60_000),
    maxRetries: clampInt(src.maxRetries, GROUP_QUOTA_DEFAULT.maxRetries, 0, 3),
  }
}

/** 这条报错是不是「群消息发太快被限流」（不同网关说法不一样，按关键词兜）。 */
export function isGroupRateLimited(message) {
  const t = String(message ?? '')
  return /每分钟只能发|发送过于频繁|too many|rate.?limit|result=299|result=120/i.test(t)
}

/**
 * 建一个按群的发送配额器。
 * @param {{getConfig?:()=>object, now?:()=>number, sleep?:(ms:number)=>Promise<void>, log?:object}} opts
 */
export function createGroupQuota({ getConfig = () => ({}), now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log } = {}) {
  /** groupId -> 最近发送时间戳数组（只保留窗口内的） */
  const sent = new Map()

  const cfgOf = () => normalizeGroupQuota((getConfig().group?.quota) || {})

  function prune(gid, t) {
    const win = cfgOf().windowMs
    const list = (sent.get(gid) || []).filter((x) => t - x < win)
    sent.set(gid, list)
    return list
  }

  /**
   * 发一条群消息：先等配额，再发；被限流就等一个窗口重试。
   * @param {string} groupId
   * @param {(payload?:any)=>Promise<any>} doSend 真正发送的函数（返回非空 = 成功）
   * @returns {Promise<{ok:boolean, result?:any, waitedMs:number, retries:number, error?:Error}>}
   */
  async function send(groupId, doSend) {
    const cfg = cfgOf()
    const gid = String(groupId || '')
    let waitedMs = 0
    let retries = 0
    if (cfg.enabled) {
      // ① 预防：窗口内已经发到「上限 − 余量」就先等
      const limit = Math.max(1, cfg.perMinute - cfg.reserve)
      const list = prune(gid, now())
      if (list.length >= limit) {
        const wait = Math.max(0, cfg.windowMs - (now() - list[0]) + 250)
        if (wait > 0 && wait <= cfg.windowMs) {
          log?.info?.(`群 ${gid}：1 分钟内已发 ${list.length} 条（QQ 上限 ${cfg.perMinute}），等 ${Math.ceil(wait / 1000)}s 再发`)
          await sleep(wait)
          waitedMs += wait
          prune(gid, now())
        }
      }
    }
    for (;;) {
      try {
        const result = await doSend()
        prune(gid, now()).push(now())
        return { ok: true, result, waitedMs, retries }
      } catch (error) {
        const limited = isGroupRateLimited(error?.message)
        if (!limited || retries >= cfg.maxRetries) {
          return { ok: false, waitedMs, retries, error }
        }
        retries += 1
        log?.warn?.(`群 ${gid}：被 QQ 限流（${error.message}），等 ${Math.ceil(cfg.retryWaitMs / 1000)}s 重试`)
        await sleep(cfg.retryWaitMs)
        waitedMs += cfg.retryWaitMs
        prune(gid, now())
      }
    }
  }

  /** 面板/诊断用：这个群当前窗口里发了几条。 */
  function usage(groupId) {
    const cfg = cfgOf()
    const list = prune(String(groupId || ''), now())
    return { sent: list.length, perMinute: cfg.perMinute, limit: Math.max(1, cfg.perMinute - cfg.reserve), windowMs: cfg.windowMs }
  }

  function reset(groupId) {
    if (groupId) sent.delete(String(groupId))
    else sent.clear()
  }

  return { send, usage, reset }
}