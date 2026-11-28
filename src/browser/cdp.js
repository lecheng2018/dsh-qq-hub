// 一条 CDP 连接：发命令、收事件、断线可感知。
//
// 用的是 Node 自带的 WebSocket（22+），不引第三方依赖。
// 只管「连上并收发」，不认识抖音也不认识贴吧。

import { setTimeout as sleep } from 'node:timers/promises'

/** 读本地调试口的 JSON（/json/version、/json/list 之类）。 */
export async function getJson(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** 等调试口起来；最多等 timeoutMs。返回 true/false。 */
export async function waitDebugger(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await getJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)) return true
    await sleep(250)
  }
  return false
}

/**
 * 连一条 CDP。
 * @param {string} wsUrl
 * @param {{ WS?: any, timeoutMs?: number }} [o]
 */
export function connectCdp(wsUrl, { WS = globalThis.WebSocket, timeoutMs = 10000 } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
  const sock = new WS(wsUrl)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const listeners = new Map()

  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) {
        try { fn(msg.params || {}) } catch {}
      }
    }
  })

  const closeHandlers = new Set()
  sock.addEventListener('close', () => {
    closed = true
    for (const p of pending.values()) p.reject(new Error('浏览器连接断了'))
    pending.clear()
    for (const fn of closeHandlers) { try { fn() } catch {} }
  })

  const ready = new Promise((resolve, reject) => {
    // 不能 unref：这个计时器是 ready 这条 Promise 唯一的失败出口
    const t = setTimeout(() => reject(new Error('连不上浏览器调试端口')), timeoutMs)
    sock.addEventListener('open', () => { clearTimeout(t); resolve() })
    sock.addEventListener('error', () => { clearTimeout(t); reject(new Error('连不上浏览器调试端口')) })
  })

  return {
    ready,
    get closed() { return closed },
    send(method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        // 不能 unref：send() 在等这个计时器
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器没响应（${method}）`)) }, ms)
        pending.set(id, {
          resolve: (v) => { clearTimeout(t); resolve(v) },
          reject: (e) => { clearTimeout(t); reject(e) },
        })
        sock.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    onClose(fn) {
      closeHandlers.add(fn)
      return () => closeHandlers.delete(fn)
    },
    close() { try { sock.close() } catch {} },
  }
}

/**
 * 在 CDP 层拦每一次请求和重定向。
 *
 * 为什么不能只在 goto 前检查一次：页面里的 302 跳转、iframe、location 赋值都能把浏览器带去别处。
 *
 * 分级处理（重要）：
 *   - 导航（Document）：过**白名单**，只许去登记的站点
 *   - 子资源（图片/脚本/视频/XHR）：只过**安全过滤**（拦本机、内网、字面 IP、非 http(s)）
 *
 * 子资源不能按白名单卡：网站自己的 CDN 域名列不完，全卡掉会把页面直接卡死。
 *
 * @param {object} cdp
 * @param {{ check: Function, safetyCheck?: Function }} policy
 * @param {{ onBlock?: (url: string, reason: string) => void }} [o]
 * @returns {Promise<() => Promise<void>>} 卸载函数
 */
/** Fetch 域只拿到 URL，不区分 scheme：这几个是页面正常渲染要用的「无网络」协议。 */
const SAFE_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/**
 * 协议闸：只有 http(s) 与 data/blob/about 放行。
 * ws:/wss:/file:/ftp:/... 一律拒绝 —— 旧实现只登记了 http/https 两个 pattern，
 * 于是 `ws://127.0.0.1:9222/...`、`file:///etc/passwd` 这类请求根本不进 Fetch 域，
 * 等于页面里的脚本可以绕开 safetyCheck 直接连本机 WebSocket 或读本地文件。
 * @param {string} url
 */
export function schemeAllowed(url) {
  let scheme = ''
  try { scheme = new URL(String(url || '')).protocol.toLowerCase() } catch { return false }
  return scheme === 'http:' || scheme === 'https:' || SAFE_SCHEMES.has(scheme)
}

/** WebSocket 回环：即使 scheme 被判为 ws，也要按安全过滤看主机名。 */
export function isLoopbackWsUrl(url) {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]'
  } catch { return false }
}

export async function installRequestGuard(cdp, policy, { onBlock } = {}) {
  // '*' 才覆盖 ws/wss/file 等非 http(s) 请求；具体放行与否交给下面的协议闸
  const patterns = [{ urlPattern: '*' }]
  await cdp.send('Fetch.enable', { patterns })
  const safety = policy.safetyCheck || policy.check
  const off = cdp.on('Fetch.requestPaused', (p) => {
    const url = p.request?.url || ''
    const block = (reason) => {
      try { onBlock?.(url, reason) } catch {}
      cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    }
    if (!schemeAllowed(url)) return block(`不允许的协议：${url}`)
    const scheme = new URL(url).protocol.toLowerCase()
    if (SAFE_SCHEMES.has(scheme)) {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {})
      return
    }
    const isNav = p.resourceType === 'Document'
    const verdict = isNav ? policy.check(url) : safety(url)
    if (verdict.ok) {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {})
      return
    }
    block(verdict.reason || '被拦下')
  })
  return async () => {
    off()
    await cdp.send('Fetch.disable').catch(() => {})
  }
}