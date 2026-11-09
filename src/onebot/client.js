// OneBot v11 客户端：HTTP 调接口，WS（Universal）收事件，断线自动重连。
// 只依赖 Node 自带的 fetch / WebSocket。

const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000
// 网关短暂不可用（SnowLuma 刚被重启、端口还没释放）时，发消息别直接丢：等一会儿再试
const RETRY_DELAYS = [1000, 3000, 5000]
// M1-C：副作用动作在「请求可能已送达」的失败上不允许自动重试——
// 只有能确证「连接都没建起来、请求没出门」的网络错误（refused/DNS/不可达）才可安全重试；
// 超时、连接中途断开、响应丢失、响应无法解析成合法信封一律标 unknown（副作用可能已发生），
// 由调用方按 unknown 状态处理，严禁「请求失败即可安全重发」的旧假设（ADR-0001：unknown 不能自动重试）。
// 策略方向（代码审查 P1 修正）：旧的 SEND_ACTIONS 只显式列了 5 个发送动作，漏掉了
// send_group_forward_msg / send_private_forward_msg / send_qzone_msg / set_* / delete_* / *_qzone 等
// 真实存在的副作用动作。现改为反向白名单：只有下面显式枚举的幂等查询（READ_ACTIONS）默认可回退/重试，
// 其余一律按副作用对待——枚举漏一个查询只是少一次重试（保守、无害），漏一个副作用则是重复发消息（有害）。
const READ_ACTIONS = new Set([
  // 纯查询（get_*）：幂等，失败了可以安全重发
  'get_login_info', 'get_status', 'get_stranger_info', 'get_friend_list', 'get_group_list',
  'get_group_info', 'get_group_member_info', 'get_group_member_list', 'get_msg', 'get_forward_msg',
  'get_group_msg_history', 'get_friend_msg_history', 'get_group_file_url', 'get_private_file_url',
  'get_record', 'get_image', 'get_qzone_feeds', 'get_qzone_msg_list', 'get_qzone_msg_detail',
  'get_doubt_friends_add_request',
  // 权限预检查（can_*）：只读不回写
  'can_send_group_msg', 'can_send_private_msg',
  // 媒体/转写读取：网关只是转码或取回文本，无对外副作用
  'fetch_ptt_text', 'fetch_custom_face',
])
/** 副作用动作 = 不在只读白名单里的一切（send_*、set_*、delete_*、*_qzone、upload_*、请求处理等）。 */
const isSideEffect = (action) => !READ_ACTIONS.has(action)
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class OneBotError extends Error {
  constructor(action, data, { transport = false, preSend = false } = {}) {
    super(`${action} 失败：${data?.message || data?.wording || data?.retcode || '未知错误'}`)
    this.action = action
    this.data = data
    // transport = 根本没连上网关/没拿到合法应答（查询类可重试）；业务错误（合法信封 retcode 不为 0）不重试
    // preSend = 网络错误发生在请求出门之前（连接被拒/DNS/不可达），副作用动作也可安全重试
    // unknown = 副作用可能已发生（超时/中途断开/应答不是合法信封），禁止自动重试与 WS 补发，调用方按 unknown 状态处理
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
      const sideEffect = isSideEffect(action)
      try {
        const headers = { 'content-type': 'application/json' }
        if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`
        const r = await fetch(`${ep.httpUrl.replace(/\/+$/, '')}/${action}`, {
          method: 'POST', headers, body: JSON.stringify(params), signal: ctrl.signal,
        })
        // 只有「解析成功且形如 OneBot 信封（有数字 retcode 或字符串 status）」的应答才允许下明确结论。
        // 反代/网关故障返回的 502 HTML 之类不能被合成成 retcode 冒充「网关明确拒绝」——
        // 那样下游（hub 的 unknown 判断、媒体 base64 回退、outbox failed 记账）会当确定没发生而重发。
        // 信封无效时：副作用动作 → 结果不明（由 call() 标 unknown）；查询动作 → 按传输失败处理（可重试）。
        let j = null
        try { j = await r.json() } catch (error) {}
        if (!j || typeof j !== 'object' || (typeof j.retcode !== 'number' && typeof j.status !== 'string')) {
          const why = `网关应答不是合法 OneBot 信封（HTTP ${r.status}）`
          if (sideEffect) throw new OneBotError(action, { message: why })
          throw new OneBotError(action, { message: why }, { transport: true })
        }
        if (j.status === 'ok' || j.retcode === 0) return j.data
        throw new OneBotError(action, j) // 明确拒绝（definite failure）：副作用确证没发生，调用方可按业务错误处理
      } catch (error) {
        if (error instanceof OneBotError) throw error
        // 超时可能是"已经发出去了只是没等到回执"，重试会重复发消息 —— 不重试（call() 对副作用标 unknown）
        if (error.name === 'AbortError') throw new OneBotError(action, { message: '超时' })
        const code = String(error?.cause?.code || error?.code || '')
        // HTTP 网络错误（请求可能已出门甚至已执行）：只有幂等查询允许在同一次调用里换 WS 补发；
        // 副作用动作 WS 回退 = 网关已处理过 HTTP 请求时重复执行一遍 —— 禁止，交给 call() 标 unknown。
        if (!sideEffect && ws && ws.readyState === 1) {
          return await callWs(action, params, timeoutMs)
        }
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
          // 合法信封的明确拒绝 = 副作用确证没发生，可按 definite failure 上抛
          const businessReject = !error.transport && typeof error.data?.retcode === 'number' && error.data.retcode !== 0
          if (isSideEffect(action) && !businessReject && !(error.transport && error.preSend)) {
            // M1-C：副作用动作只允许在「确证请求没出门」时重试；
            // 超时 / 中途断开 / 响应丢失 / 应答不是合法信封 = unknown，立即上抛，绝不自动重发
            error.unknown = true
            throw error
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
