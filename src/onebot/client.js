// OneBot v11 客户端：HTTP 调接口，WS（Universal）收事件，断线自动重连。
// 只依赖 Node 自带的 fetch / WebSocket。

const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000
// 网关短暂不可用（SnowLuma 刚被重启、端口还没释放）时，发消息别直接丢：等一会儿再试
const RETRY_DELAYS = [1000, 3000, 5000]
// M1-C：发送类动作（副作用）在「请求可能已送达」的失败上不允许自动重试——
// 只有能确证「连接都没建起来、请求没出门」的网络错误（refused/DNS/不可达）才可安全重试；
// 超时、连接中途断开、响应丢失一律标 unknown（副作用可能已发生），由调用方按状态处理，
// 严禁「请求失败即可安全重发」的旧假设（ADR-0001：unknown 不能自动重试）。
const SEND_ACTIONS = new Set(['send_group_msg', 'send_private_msg', 'send_poke', 'upload_group_file', 'upload_private_file'])
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class OneBotError extends Error {
  constructor(action, data, { transport = false, preSend = false } = {}) {
    super(`${action} 失败：${data?.message || data?.wording || data?.retcode || '未知错误'}`)
    this.action = action
    this.data = data
    // transport = 根本没连上网关（查询类可重试）；业务错误（retcode 不为 0、超时但也可能已经发出去）不重试
    // preSend = 网络错误发生在请求出门之前（连接被拒/DNS/不可达），发送类动作也可安全重试
    // unknown = 副作用可能已发生（超时/中途断开），发送类动作禁止重试，调用方按 unknown 状态处理
    this.transport = transport
    this.preSend = preSend
    this.unknown = false
  }
}

/**
 * @param {object} o
 * @param {() => {httpUrl:string, wsUrl:string, httpToken:string, wsToken:string}} o.endpoint 每次连接时现取
 * @param {(event: object) => void} o.onEvent
 * @param {(state: string, detail?: string) => void} [o.onState]
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 */
export function createOneBotClient({ endpoint, onEvent, onState, log, retryDelays = RETRY_DELAYS }) {
  let ws = null
  let stopped = true
  let timer = null
  let pingTimer = null
  let lastMessageAt = 0
  let backoff = RECONNECT_MIN
  let state = 'stopped'
  let echoSeq = 0
  const pending = new Map()

  const setState = (s, detail) => {
    if (state === s) return
    state = s
    try { onState?.(s, detail) } catch (error) {}
  }

  /** 走一次 HTTP 或 WS；网络层失败标成 transport，业务错误照原样抛。 */
  async function callOnce(action, params, timeoutMs) {
    const ep = endpoint()
    if (ep.httpUrl) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const headers = { 'content-type': 'application/json' }
        if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`
        const r = await fetch(`${ep.httpUrl.replace(/\/+$/, '')}/${action}`, {
          method: 'POST', headers, body: JSON.stringify(params), signal: ctrl.signal,
        })
        const j = await r.json().catch(() => ({ status: 'failed', retcode: r.status, message: `HTTP ${r.status}` }))
        if (j.status === 'ok' || j.retcode === 0) return j.data
        throw new OneBotError(action, j)
      } catch (error) {
        if (error instanceof OneBotError) throw error
        // 超时可能是"已经发出去了只是没等到回执"，重试会重复发消息 —— 不重试
        if (error.name === 'AbortError') throw new OneBotError(action, { message: '超时' })
        if (ws && ws.readyState === 1) {
          try { return await callWs(action, params, timeoutMs) } catch (wsError) { throw wsError }
        }
        const code = String(error?.cause?.code || error?.code || '')
        // 网络层失败：标 transport + 是否「请求未出门」（refused/DNS/不可达 = 连接没建立）
        throw new OneBotError(action, { message: describeNetError(error, ep) }, { transport: true, preSend: PRE_SEND_CODES.has(code) })
      } finally {
        clearTimeout(t)
      }
    }
    return callWs(action, params, timeoutMs)
  }

  function describeNetError(error, ep) {
    const where = ep.httpUrl || ep.wsUrl || '(没配地址)'
    const why = error?.cause?.code || error?.cause?.message || error?.message || String(error)
    return `连不上 QQ 网关（${where}）：${why}`
  }

  async function call(action, params = {}, { timeoutMs = 30000, retries = retryDelays.length } = {}) {
    const ep0 = endpoint()
    // 压根没配网关：立即失败，别让调用方白等重试（查群名之类的会立刻回退）
    if (!ep0.httpUrl && !ep0.wsUrl) {
      throw new OneBotError(action, { message: '还没配置 QQ 网关地址' }, { transport: true })
    }
    let lastError = null
    for (let i = 0; i <= retries; i++) {
      try {
        return await callOnce(action, params, timeoutMs)
      } catch (error) {
        lastError = error
        if (error instanceof OneBotError) {
          const businessReject = !error.transport && error.data?.retcode !== undefined && error.data.retcode !== 0
          if (SEND_ACTIONS.has(action) && !businessReject) {
            // M1-C：发送类动作只允许在「确证请求没出门」时重试；
            // 超时 / 中途断开 / 响应丢失 = unknown，立即上抛，绝不自动重发
            if (!(error.transport && error.preSend)) {
              error.unknown = true
              throw error
            }
          }
        }
        // 业务错误（比如没权限、参数不对）重试也没用
        if (!(error instanceof OneBotError) || !error.transport) throw error
        if (i === retries) break
        const wait = retryDelays[i] ?? retryDelays[retryDelays.length - 1]
        log?.warn?.(`${action}：网关暂时连不上，${wait / 1000}s 后重试（${i + 1}/${retries}）`)
        await sleep(wait)
      }
    }
    throw lastError
  }

  function callWs(action, params, timeoutMs) {
    if (!ws || ws.readyState !== 1) return Promise.reject(new OneBotError(action, { message: '没连上 QQ 网关' }, { transport: true }))
    const echo = `ab-${Date.now()}-${++echoSeq}`
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(echo)
        reject(new OneBotError(action, { message: '超时' }))
      }, timeoutMs)
      pending.set(echo, { resolve, reject, t, action })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  function connect() {
    if (stopped) return
    const ep = endpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', '没有 WS 地址')
      schedule()
      return
    }
    setState('connecting')
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let sock
    try {
      sock = new WebSocket(url)
    } catch (error) {
      log.warn('WS 连接失败：', error.message)
      schedule()
      return
    }
    ws = sock
    sock.onopen = () => {
      backoff = RECONNECT_MIN
      lastMessageAt = Date.now()
      setState('connected')
      log.info('已连上 QQ 网关（WS）')
      clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1 && Date.now() - lastMessageAt > 90_000) {
          log?.warn?.('QQ 网关 90 秒内无任何心跳/事件包，判定半开连接假死，强制重连')
          try { ws.close() } catch {}
        }
      }, 30_000)
      pingTimer.unref?.()
    }
    sock.onmessage = (ev) => {
      lastMessageAt = Date.now()
      let data
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch (error) { return }
      if (data && data.echo && pending.has(data.echo)) {
        const p = pending.get(data.echo)
        pending.delete(data.echo)
        clearTimeout(p.t)
        if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data)
        else p.reject(new OneBotError(p.action, data))
        return
      }
      if (data && data.post_type) {
        try { onEvent(data) } catch (error) { log.warn('处理事件出错：', error.message) }
      }
    }
    sock.onclose = (ev) => {
      clearInterval(pingTimer)
      if (ws === sock) ws = null
      for (const [k, p] of pending) {
        clearTimeout(p.t)
        p.reject(new OneBotError(p.action, { message: '连接断开' }))
        pending.delete(k)
      }
      if (!stopped) {
        setState('disconnected', `code ${ev?.code ?? ''}`)
        schedule()
      }
    }
    sock.onerror = () => {}
  }

  function schedule() {
    clearTimeout(timer)
    clearInterval(pingTimer)
    if (stopped) return
    timer = setTimeout(connect, backoff)
    backoff = Math.min(RECONNECT_MAX, backoff * 2)
  }

  return {
    call,
    start() {
      if (!stopped) return
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      clearInterval(pingTimer)
      setState('stopped')
      try { ws?.close() } catch (error) {}
      ws = null
    },
    restart() {
      this.stop()
      this.start()
    },
    get state() {
      return state
    },
  }
}
