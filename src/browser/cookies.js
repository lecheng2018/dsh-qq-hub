// Cookie 读写：走 CDP，不碰 Electron 的 session。
//
// 贴吧原本靠 Electron 的 ses.cookies.get/set + clearStorageData + flushStore，
// 这些东西 CDP 都有等价物；而且用持久 profile 时**不需要 flushStore**（Chrome 自己会落盘）。

/**
 * 读 Cookie。
 * @param {object} cdp
 * @param {{ urls?: string[] }} [o] 不传 = 全量（含所有域）
 */
export async function getCookies(cdp, { urls = [] } = {}) {
  const r = await cdp.send('Network.getAllCookies').catch(() => null)
  const all = r?.cookies || []
  if (!urls.length) return all
  return all.filter((c) => urls.some((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase()
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase()
      return host === d || host.endsWith('.' + d)
    } catch { return false }
  }))
}

/**
 * 写 Cookie。
 * @param {object} cdp
 * @param {Array<{name:string,value:string,domain?:string,url?:string,path?:string,secure?:boolean,httpOnly?:boolean,sameSite?:string}>} list
 */
export async function setCookies(cdp, list = []) {
  const failed = []
  for (const c of list) {
    if (!c?.name) continue
    const params = {
      name: String(c.name),
      value: String(c.value ?? ''),
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: Boolean(c.httpOnly),
      ...(c.domain ? { domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain } : {}),
      ...(c.url ? { url: c.url } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }
    if (!params.domain && !params.url) params.url = 'https://' + (c.host || 'localhost')
    const r = await cdp.send('Network.setCookie', params).catch((e) => ({ success: false, error: e }))
    if (r && r.success === false) failed.push({ name: c.name, error: r.error || '写入失败' })
  }
  return { failed }
}

/** 清站点数据（Cookie + localStorage），对应贴吧的 clearStorageData。 */
export async function clearOrigin(cdp, origin) {
  if (!origin) {
    await cdp.send('Network.clearBrowserCookies').catch(() => {})
    return
  }
  await cdp.send('Storage.clearDataForOrigin', {
    origin,
    storageTypes: 'cookies,local_storage,session_storage,indexeddb,cache_storage',
  }).catch(() => {})
}

/** 把「BDUSS=xxx; STOKEN=yyy」这种整串拆成可 setCookie 的数组。只保留白名单里的名字。 */
export function parseCookieString(raw, allowNames) {
  const allow = allowNames ? new Set(allowNames) : null
  return String(raw || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      if (i < 1) return null
      const name = p.slice(0, i).trim()
      const value = p.slice(i + 1).trim()
      if (allow && !allow.has(name)) return null
      return { name, value }
    })
    .filter(Boolean)
}