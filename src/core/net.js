// 下载图片 / 语音：限大小、限协议、挡掉内网地址（防 SSRF）。也支持 base64:// 和本地文件。

import { readFileSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

function isPrivateIp(ip) {
  if (!ip) return true
  if (ip.includes(':')) {
    const s = ip.toLowerCase()
    return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s === '::' || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.')
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

export async function assertPublicUrl(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http / https')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') throw new Error('不允许访问本机地址')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((x) => x.address)
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('不允许访问内网地址')
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

  // 少数实现会直接给 url / base64，能用就直接用
  for (const src of [d.url, d.base64].filter((x) => typeof x === 'string' && x.trim())) {
    return await fetchImage(src, { ...o, maxBytes })
  }

  const fileId = String(d.file_id || d.fileId || d.id || '').trim()
  if (!fileId) throw new Error('这个文件段没有 file_id，拿不到下载地址')

  // 先按大小挡一刀，省得白跑一趟
  const declared = Number(d.file_size ?? d.fileSize ?? 0)
  if (declared > maxBytes) throw new Error(`文件太大了（${Math.round(declared / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB）`)

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
    let currentUrl = s
    let redirects = 0
    let r = null
    while (redirects < 5) {
      await assertPublicUrl(currentUrl)
      r = await fetch(currentUrl, { signal: AbortSignal.timeout(o.timeoutMs ?? 20000), redirect: 'manual' })
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        currentUrl = new URL(r.headers.get('location'), currentUrl).href
        redirects++
      } else {
        break
      }
    }
    if (!r || !r.ok) throw new Error(`HTTP ${r ? r.status : 'unknown'}`)
    const len = Number(r.headers.get('content-length') || 0)
    if (len > maxBytes) throw new Error('太大了')
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
  // 本地文件：只在调用方明确允许时读（QQ 网关在本机，给的可能是本地缓存路径）
  if (o.allowLocal !== false) {
    const p = s.startsWith('file://') ? fileURLToPath(s) : s
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      if (statSync(p).size > maxBytes) throw new Error('太大了')
      return readFileSync(p)
    }
  }
  throw new Error('不认识的地址')
}
