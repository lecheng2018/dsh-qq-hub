// 下载图片 / 语音：限大小、限协议、挡掉内网地址（防 SSRF）。也支持 base64:// 和本地文件。

import { readFileSync, statSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

/** 把 IPv6 文本解析成 16 字节（支持 :: 压缩、末尾点分 IPv4、剥括号与 zone id）。 */
export function parseIpv6ToBytes(ip) {
  if (typeof ip !== 'string') return null
  let s = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (!s) return null
  // 末尾点分 IPv4：转成两个 16 位组
  const v4Match = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  let v4Tail = ''
  if (v4Match) {
    const parts = v4Match[1].split('.').map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    v4Tail = ((parts[0] << 8 | parts[1]).toString(16) + ':' + (parts[2] << 8 | parts[3]).toString(16))
    s = s.slice(0, s.length - v4Match[1].length) + v4Tail
  }
  if (!/^[0-9a-f:.]+$/.test(s)) return null
  const doubleColon = s.indexOf('::')
  let head = []
  let tail = []
  if (doubleColon >= 0) {
    const headStr = s.slice(0, doubleColon)
    const tailStr = s.slice(doubleColon + 2)
    head = headStr ? headStr.split(':').filter(Boolean) : []
    tail = tailStr ? tailStr.split(':').filter(Boolean) : []
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    for (let i = 0; i < missing; i++) head.push('0')
  } else {
    head = s.split(':')
    if (head.length !== 8) return null
  }
  const groups = [...head, ...tail]
  if (groups.length !== 8) return null
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i]
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes[i * 2] = n >> 8
    bytes[i * 2 + 1] = n & 0xff
  }
  return bytes
}

function isPrivateV4(ip) {
  const parts = String(ip).split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
}

function isPrivateV6(bytes) {
  const [b0, b1] = bytes
  // ULA fc00::/7
  if ((b0 & 0xfe) === 0xfc) return true
  // 链路本地 fe80::/10
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true
  // 旧站本地 fec0::/10（RFC 3879 已废弃，实际仍可能出现在内网）
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true
  // 组播 ff00::/8
  if (b0 === 0xff) return true
  // ::/128 未指定
  if (bytes.every((v) => v === 0)) return true
  // ::1/128 回环
  if (bytes.slice(0, 15).every((v) => v === 0) && bytes[15] === 1) return true
  // ::ffff:0:0/96 IPv4-mapped
  if (bytes.slice(0, 10).every((v) => v === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateV4([...bytes.slice(12)].join('.'))
  }
  // ::ffff:0:0:0/96 IPv4-translated（RFC 2765 SIIT，内嵌 IPv4 在末 4 字节）
  if (bytes.slice(0, 8).every((v) => v === 0)
    && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0x00 && bytes[11] === 0x00) {
    return isPrivateV4([...bytes.slice(12)].join('.'))
  }
  // ::/96 IPv4-compatible（如 ::7f00:1）
  if (bytes.slice(0, 12).every((v) => v === 0)) {
    return isPrivateV4([...bytes.slice(12)].join('.'))
  }
  // 64:ff9b::/96 NAT64
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((v) => v === 0)) {
    return isPrivateV4([...bytes.slice(12)].join('.'))
  }
  // 64:ff9b:1::/48 NAT64 本地
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01) {
    return isPrivateV4([...bytes.slice(12)].join('.'))
  }
  // 2002::/16 6to4（内嵌 IPv4 在 bytes[2..5]）
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateV4([bytes[2], bytes[3], bytes[4], bytes[5]].join('.'))
  }
  // 100::/64 丢弃前缀（RFC 6666）
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((v) => v === 0)) return true
  // 2001:db8::/32 文档段
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true
  // 2001:2::/48 Benchmarking
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return true
  // 2001:10::/28 ORCHID
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x10) return true
  // 2001::/32 Teredo（内嵌 IPv4 但不足信，整段视为不可达内网）
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true
  return false
}

export function isPrivateIp(ip) {
  if (!ip) return true
  if (String(ip).includes(':')) {
    const bytes = parseIpv6ToBytes(ip)
    if (!bytes) return true
    return isPrivateV6(bytes)
  }
  return isPrivateV4(ip)
}

export async function assertPublicUrl(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http / https')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((x) => x.address)
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('不允许访问内网地址')
}

/**
 * 给 undici Agent 的 connect 选项：socket 连接前按目标主机名重新校验 IP（DNS rebinding 防护）。
 *
 * 注意必须用回调版 `node:dns` 的 lookup：Promise 版第三参数不是回调，
 * 写错会让回调永远不执行，所有公网下载挂死到超时（#270 遗留 P0）。
 * 兼容 `safeLookup(host, cb)` 与 `safeLookup(host, opts, cb)`，
 * 并按 Node 约定在 `opts.all` 时回数组、否则回 `(address, family)`。
 */
export function safeLookup(hostname, opts, cb) {
  let options = opts
  let callback = cb
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  if (typeof callback !== 'function') return
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = (Array.isArray(addresses) ? addresses : (addresses ? [addresses] : [])).filter(Boolean)
    const ips = list.map((x) => x.address)
    if (!ips.length || ips.some(isPrivateIp)) return callback(new Error('不允许访问内网地址'))
    // 调用方（undici / net.connect）可能显式指定 family 4/6：先按校验过的全量列表判安全，
    // 再按协议族过滤，避免把 AAAA 结果回给只想要 v4 的连接（反之亦然）。
    const family = Number(options?.family)
    const usable = (family === 4 || family === 6)
      ? list.filter((x) => Number(x.family) === family)
      : list
    if (!usable.length) return callback(new Error(`没有可用的 IPv${family} 地址`))
    if (options && options.all) return callback(null, usable)
    callback(null, usable[0].address, usable[0].family)
  })
}

// 全局只建一个 undici Agent：连接池与定时器复用，避免每次请求/重定向泄漏。
let safeDispatcherPromise = null

/**
 * 取复用的安全 dispatcher。undici 不可用时 fail-closed 抛错，
 * 绝不静默退回不带 connect.lookup 的裸 fetch（否则 DNS rebinding 防线整体失效）。
 */
export function getSafeDispatcher() {
  if (!safeDispatcherPromise) {
    safeDispatcherPromise = import('undici')
      .then(({ Agent }) => new Agent({ connect: { lookup: safeLookup } }))
      .catch((err) => {
        safeDispatcherPromise = null
        throw err
      })
  }
  return safeDispatcherPromise
}

/**
 * 取一个 OneBot 图片 / 表情段的字节：先试 url，再试 file；都不行就问网关 get_image 换真实地址。
 * （SnowLuma 对内联来源的图片只给 `file: <md5>.png`，url 为空。）
 */
export async function segmentBytes(seg, onebot, o = {}) {
  const d = (seg && seg.data) || {}
  const tries = [d.url, d.file, d.path].filter((x) => typeof x === 'string' && x.trim())
  let lastErr = null
  for (const src of tries) {
    try {
      return await fetchImage(src, o)
    } catch (error) {
      lastErr = error
    }
  }
  if (onebot && d.file) {
    try {
      const info = await onebot.call('get_image', { file: d.file }, { timeoutMs: 15000 })
      for (const src of [info?.file, info?.url].filter(Boolean)) {
        try {
          return await fetchImage(src, o)
        } catch (error) {
          lastErr = error
        }
      }
    } catch (error) {
      lastErr = error
    }
  }
  throw lastErr || new Error('这个图片段没有可用的地址')
}

/**
 * 把一个「文件段」变成字节。
 *
 * 和图片不一样：QQ 的文件消息里只有 file_id，没有直链，必须再调一次接口换地址。
 * NapCat / SnowLuma 系：
 *   私聊 get_private_file_url { user_id, file_id }       → { url }
 *   群聊 get_group_file_url  { group_id, file_id, busid } → { url }
 * 换出来的地址有时效（一般 5 分钟），拿到就要马上 down，不能存着。
 *
 * @param {object} seg 文件段（seg.data 里应有 file_id / file_name / file_size，群聊还有 busid）
 * @param {{call:Function}} onebot OneBot 调用器
 * @param {{chat?:{kind:string,userId?:string,groupId?:string}, maxBytes?:number, timeoutMs?:number}} o
 * @returns {Promise<Buffer>}
 */
export async function fileSegmentBytes(seg, onebot, o = {}) {
  const d = (seg && seg.data) || {}
  const maxBytes = o.maxBytes ?? 20 * 1024 * 1024

  // 先按大小挡一刀，省得白跑一趟；直接给 url/base64 也不能绕过
  const declared = Number(d.file_size ?? d.fileSize ?? 0)
  if (declared > maxBytes) throw new Error(`文件太大了（${Math.round(declared / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB）`)

  // 少数实现会直接给 url / base64，能用就直接用
  for (const src of [d.url, d.base64].filter((x) => typeof x === 'string' && x.trim())) {
    return await fetchImage(src, { ...o, maxBytes })
  }

  const fileId = String(d.file_id || d.fileId || d.id || '').trim()
  if (!fileId) throw new Error('这个文件段没有 file_id，拿不到下载地址')

  const chat = o.chat || {}
  const isGroup = (chat.kind || d._kind || '') === 'group' || Boolean(chat.groupId)
  let info = null
  if (isGroup) {
    info = await onebot.call('get_group_file_url', {
      group_id: Number(chat.groupId || d.group_id || 0),
      file_id: fileId,
      busid: Number(d.busid ?? d.bus_id ?? 0) || 0,
    }, { timeoutMs: 15000 })
  } else {
    info = await onebot.call('get_private_file_url', {
      user_id: Number(chat.userId || d.user_id || 0),
      file_id: fileId,
    }, { timeoutMs: 15000 })
  }
  const url = info?.url || info?.file || info?.data?.url
  if (!url) throw new Error('没能换来下载地址（接口没给 url）')
  return await fetchImage(url, { ...o, maxBytes })
}

/**
 * @param {string} src http(s) 地址 / base64://… / file:// / 本地绝对路径
 * @param {{maxBytes?:number, timeoutMs?:number, allowLocal?:boolean}} [o]
 */
export async function fetchImage(src, o = {}) {
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024
  const s = String(src || '').trim()
  if (!s) throw new Error('没有地址')
  if (s.startsWith('base64://')) {
    const buf = Buffer.from(s.slice(9), 'base64')
    if (buf.length > maxBytes) throw new Error('太大了')
    return buf
  }
  if (/^https?:\/\//i.test(s)) {
    // 连接层二次校验：undici Agent 在 socket 建立前用 safeLookup 重新解析并拦截内网 IP，
    // 阻断「assertPublicUrl 校验通过、fetch 实际连到另一 IP」的 DNS rebinding 绕过。
    // Agent 全模块复用一份；undici 不可用时 getSafeDispatcher() fail-closed 抛错。
    const dispatcher = await getSafeDispatcher()
    let currentUrl = s
    let redirects = 0
    let r = null
    for (;;) {
      await assertPublicUrl(currentUrl)
      r = await fetch(currentUrl, { signal: AbortSignal.timeout(o.timeoutMs ?? 20000), redirect: 'manual', dispatcher })
      if (!(r.status >= 300 && r.status < 400 && r.headers.get('location'))) break
      // 丢弃的这一跳响应体必须 cancel，否则底层连接挂在池里不回收
      try { await r.body?.cancel?.() } catch { /* 丢弃的这一跳：cancel 失败不影响后续 */ }
      redirects++
      if (redirects >= 5) throw new Error('重定向次数过多')
      currentUrl = new URL(r.headers.get('location'), currentUrl).href
    }
    if (!r || !r.ok) {
      // 复用同一个单例 Agent 时，未消费的非 2xx 响应体会拖住连接池里的那条连接
      try { await r?.body?.cancel?.() } catch { /* 已经要抛 HTTP 错，cancel 失败不影响结果 */ }
      throw new Error(`HTTP ${r ? r.status : 'unknown'}`)
    }
    const len = Number(r.headers.get('content-length') || 0)
    if (len > maxBytes) {
      try { await r.body?.cancel?.() } catch { /* 已经要抛「太大了」，cancel 失败不影响结果 */ }
      throw new Error('太大了')
    }
    const reader = r.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { reader.cancel() } catch (e) {}
        throw new Error('太大了')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  // 本地文件：只在调用方明确允许时读（S3 防御深度：默认拒绝——QQ 网关给的 path 字段
  // 属半可信输入，万一某实现把用户可影响的字符串放进来，不能拿本地任意文件当图片读）。
  // 明确允许的调用点传 allowLocal: true。
  if (o.allowLocal === true) {
    const p = s.startsWith('file://') ? fileURLToPath(s) : s
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      if (statSync(p).size > maxBytes) throw new Error('太大了')
      return readFileSync(p)
    }
  }
  throw new Error('不认识的地址')
}
