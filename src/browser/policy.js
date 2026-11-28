// 浏览器导航白名单：fail-closed。
//
// 为什么要单独一份而不是复用 core/net.js 的 assertPublicUrl：
//   1. net.js 是给 fetch 用的，会在解析后校验 IP；浏览器自己解析 DNS，我们拿不到那一刻的 IP；
//   2. 浏览器还必须挡「字面 IP / localhost / 内嵌凭据 / 非 http(s)」，规则比 net.js 更多；
//   3. 上游 browser-ops 的白名单是 fail-open（空白名单 = 全放行），这里是**反过来的**：
//      空白名单 = 拒绝一切。宁可让主人手动填域名，也不能默认把浏览器开成任意 URL 出口。

import { isPrivateIp } from '../core/net.js'

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** 主机名规范化：统一小写、去 IPv6 方括号、剥掉末尾所有点（`localhost.` / `foo.localhost..` 等价于 `localhost`）。 */
export function normalizeHost(host) {
  return String(host || '').replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
}

/** 是不是字面 IP（v4 或 v6）。字面 IP 一律拒：没法按域名白名单管，且极易指向内网。 */
export function isLiteralIp(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '')
  return IPV4_RE.test(h) || h.includes(':')
}

/**
 * 私网 / 链路本地 / 云 metadata。只对字面 IP 生效（域名交给白名单管）。
 * @param {string} host
 */
export function isPrivateHost(host) {
  // 尾点（FQDN 绝对形式）必须剥掉：`localhost.` 是合法写法的环回地址，
  // 不剥就有 `isPrivateHost('localhost.') === false` 的绕过（同 `foo.localhost..`）。
  const h = normalizeHost(host)
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // 只有字面 IP 才走私网判定；域名交给白名单（否则 isPrivateIp 会把「不是 IP」当畸形值一律判内网）
  if (!isLiteralIp(h)) return false
  return isPrivateIp(h)
}

/** 域名尾段匹配：`douyin.com` 放行 `www.douyin.com`，但不放行 `evil-douyin.com`。 */
export function hostMatches(host, domains) {
  const h = normalizeHost(host)
  return (domains || []).some((d) => {
    const want = String(d || '').toLowerCase()
    return want && (h === want || h.endsWith('.' + want))
  })
}

/**
 * 只看「安不安全」，不看「在不在白名单」。
 * 给**子资源**用：页面要加载自己站点的 CDN（图床/视频/脚本），域名多得列不完，
 * 全部按白名单卡会把页面直接卡死；但本机/内网/字面 IP 必须一律拦住。
 * @param {string} url
 */
export function safetyCheck(url) {
  let u
  try {
    u = new URL(String(url || ''))
  } catch {
    return { ok: false, reason: '网址格式不对' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `不允许 ${u.protocol} 协议` }
  const host = normalizeHost(u.hostname)
  if (!host) return { ok: false, reason: '网址没有主机名' }
  if (isPrivateHost(host)) return { ok: false, reason: `不允许访问本机或内网地址：${host}` }
  if (isLiteralIp(host)) return { ok: false, reason: `不允许用 IP 访问：${host}` }
  return { ok: true }
}

/**
 * 造一份白名单策略。
 * @param {string[]} domains 允许的域名（含子域）。**空 = 拒绝一切**。
 */
export function createPolicy(domains = []) {
  const list = (Array.isArray(domains) ? domains : []).map((d) => String(d || '').trim()).filter(Boolean)

  /**
   * 检查一个网址能不能去（导航级：白名单 + 安全）。
   * @param {string} url
   * @returns {{ ok: boolean, reason?: string }}
   */
  function check(url) {
    if (!list.length) return { ok: false, reason: '没有配置允许访问的域名（空白名单不放行任何网址）' }
    const safe = safetyCheck(url)
    if (!safe.ok) return safe
    const u = new URL(String(url))
    if (u.username || u.password) return { ok: false, reason: '网址里不能带用户名密码' }
    if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, reason: `不允许非标准端口 ${u.port}` }
    if (!hostMatches(u.hostname, list)) return { ok: false, reason: `站点不在白名单：${u.hostname.toLowerCase()}` }
    return { ok: true }
  }

  return { check, safetyCheck, domains: [...list] }
}

/** 空白名单策略：任何网址都拒。给「模块没声明可用域名」时兜底。 */
export const DENY_ALL = createPolicy([])