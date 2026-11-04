// 拉取订阅源：超时、大小限制、内网地址拦截、单源失败不影响其他源。
//
// SSRF 是这类「用户填 URL、服务端去拉」功能的头号风险：
// 面板里填的地址是主人自己填的，但订阅源返回的内容不可信 —— 更别说万一面板泄露。
// 所以这里硬性只允许 http/https，且目标主机不能是回环/内网/链路本地地址。

export const FETCH_DEFAULTS = Object.freeze({
  timeoutMs: 15000,
  maxBytes: 2 * 1024 * 1024, // 一篇 feed 2MB 已经很大了
  maxRedirects: 3,
  concurrency: 3,           // 同时拉几个源（别把出口 IP 打成 DDOS）
  userAgent: 'dsh-qq-hub rss/1 (+https://github.com/lecheng2018/dsh-qq-hub)',
})

/** 主机是不是内网/回环/链路本地（SSRF 防护）。 */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h === 'localhost.localdomain') return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true
  // IPv6
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/i.test(h)) return true // fe80::/10 链路本地
    // IPv4-mapped（::ffff:127.0.0.1）
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h)
    if (mapped) return isPrivateHost(mapped[1])
    return false
  }
  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false // 普通域名
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 组播/保留
  return false
}

/** 校验一个订阅地址能不能拉。返回 { ok, url, error }。 */
export function checkFeedUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, error: '地址是空的' }
  let u
  try { u = new URL(s) } catch (error) { return { ok: false, error: '不是一个合法的网址' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http:// 和 https://' }
  if (isPrivateHost(u.hostname)) return { ok: false, error: '不能订阅本机或内网地址（安全限制）' }
  return { ok: true, url: u.toString() }
}

/**
 * 拉一个 feed。
 * @param {string} url
 * @param {{timeoutMs?:number, maxBytes?:number, fetchImpl?:Function, userAgent?:string}} [opts]
 * @returns {Promise<{ok:boolean, text:string, finalUrl:string, error?:string}>}
 */
export async function fetchFeed(url, { timeoutMs = FETCH_DEFAULTS.timeoutMs, maxBytes = FETCH_DEFAULTS.maxBytes, fetchImpl = fetch, userAgent = FETCH_DEFAULTS.userAgent } = {}) {
  const check = checkFeedUrl(url)
  if (!check.ok) return { ok: false, text: '', finalUrl: '', error: check.error }
  let cur = check.url
  for (let hop = 0; hop <= FETCH_DEFAULTS.maxRedirects; hop += 1) {
    let res
    try {
      res = await fetchImpl(cur, {
        headers: { 'user-agent': userAgent, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const msg = error?.name === 'TimeoutError' ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : String(error?.message || error)
      return { ok: false, text: '', finalUrl: cur, error: msg }
    }
    // 手动跟随重定向（每一跳都要重新做内网检查，否则会被 302 到 127.0.0.1）
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: false, text: '', finalUrl: cur, error: `HTTP ${res.status} 但没有跳转地址` }
      let next
      try { next = new URL(loc, cur).toString() } catch (error) { return { ok: false, text: '', finalUrl: cur, error: '跳转地址不合法' } }
      const c2 = checkFeedUrl(next)
      if (!c2.ok) return { ok: false, text: '', finalUrl: cur, error: `跳转到不允许的地址：${c2.error}` }
      cur = c2.url
      continue
    }
    if (!res.ok) return { ok: false, text: '', finalUrl: cur, error: `HTTP ${res.status}` }
    // 大小限制：先看 content-length，再实际读的时候兜一层
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes) return { ok: false, text: '', finalUrl: cur, error: `内容太大（${Math.round(len / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）` }
    try {
      const buf = await res.arrayBuffer()
      if (buf.byteLength > maxBytes) return { ok: false, text: '', finalUrl: cur, error: `内容太大（上限 ${Math.round(maxBytes / 1024)}KB）` }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
      return { ok: true, text, finalUrl: cur }
    } catch (error) {
      return { ok: false, text: '', finalUrl: cur, error: `读内容失败：${error.message}` }
    }
  }
  return { ok: false, text: '', finalUrl: cur, error: '跳转次数太多' }
}

/**
 * 并发拉多个源。单个失败不影响其他。
 * @param {Array<{id:string,url:string,title?:string}>} feeds
 * @param {{concurrency?:number, fetchImpl?:Function, timeoutMs?:number, onOne?:Function}} [opts]
 * @returns {Promise<Array<{feed, ok, text, error}>>}
 */
export async function fetchAll(feeds, { concurrency = FETCH_DEFAULTS.concurrency, ...opts } = {}) {
  const list = Array.isArray(feeds) ? feeds : []
  const results = []
  let cursor = 0
  const n = Math.max(1, Math.min(8, Number(concurrency) || FETCH_DEFAULTS.concurrency))
  async function worker() {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= list.length) return
      const feed = list[i]
      const r = await fetchFeed(feed.url, opts)
      results[i] = { feed, ...r }
      try { opts.onOne?.(feed, r) } catch (error) {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length || 1) }, () => worker()))
  return results.filter(Boolean)
}