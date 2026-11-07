// QQ Hub · 面板入站防护（M1-A）：Host 白名单（DNS rebinding）+ 改写请求同源校验（CSRF）
//
// 背景（M1-A 侦察结论，2026-11-08）：
//   面板 59 条 /qq-hub/api/* 路由此前零鉴权零防护（仅 /open/* 有 bridge Bearer token），
//   DSH 外层 webServer 是否限制监听地址/来源属部署形态（fnOS 实测留 M5），
//   插件层按「无则补齐」补上两条不破坏合法使用的防线：
//
//   1. Host 白名单（挡 DNS rebinding + 跨站伪造指向）：
//      只接受 回环名（localhost/127.0.0.1/[::1]/::1）、IP 字面量（v4/v6，含端口），
//      以及 config.security.panel.allowedHosts 里显式配置的域名（如 fnOS 的 DDNS 名）。
//      rebinding 攻击的请求 Host 是攻击者域名（evil.com），直接 403；
//      用 IP 访问面板的正常习惯不受影响。缺 Host 头（HTTP/1.1 必带）视为可疑 403。
//
//   2. 改写型方法（POST/PUT/DELETE/PATCH）同源校验（挡跨站 CSRF）：
//      带 Origin 就必须与 Host 一致（同源浏览器请求天然一致；跨站表单/fetch 一律 403）；
//      没 Origin 看 Sec-Fetch-Site（cross-site 403）；两者都没有 = 非浏览器客户端
//      （curl/脚本/测试），放行——CSRF 只能由浏览器发起，浏览器一定留下上述证据之一。
//
//   3. 不做来源 IP 限制、不信任 X-Forwarded-*（M1-A「trusted proxy」结论）：
//      面板必须继续支持局域网 IP 直访（限制回环会破坏现有用户，属未声明的行为变化）；
//      防护判定只依赖 Host/Origin/Sec-Fetch-Site，伪造 XFF 头拿不到任何东西。
//      若 DSH 前置反代，remoteAddress 是代理自身——该部署形态的来源限制由宿主层负责
//      （未覆盖形态，已登记 M1-A 证据）。
//
// fail-closed：缺头/解析失败/配置非法一律拒绝或回默认值；每个请求现读 config（热生效）。

import net from 'node:net'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

/** 从 Host 头里剥出主机名（处理 '127.0.0.1:8080' 与 '[::1]:8080' 两种形态）。 */
export function hostNameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase()
  if (!raw) return ''
  const bracket = raw.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracket) return bracket[1]
  const hostPort = raw.match(/^([^:]+):(\d+)$/) // 无括号 host:port（host 内不含冒号）
  return hostPort ? hostPort[1] : raw
}

export function createPanelGuard({ getConfig, log }) {
  const debug = (msg) => { try { log?.debug?.(msg) } catch {} }

  function hostAllowed(hostHeader) {
    const name = hostNameOf(hostHeader)
    if (!name) return false // 无 Host：可疑，拒绝
    if (LOCAL_HOSTS.has(name)) return true
    if (net.isIP(name)) return true // IP 字面量：局域网/回环直访
    const extra = (getConfig()?.security?.panel?.allowedHosts || [])
      .map((s) => hostNameOf(String(s)))
      .filter(Boolean)
    return extra.includes(name)
  }

  /**
   * @returns {{ok:true} | {ok:false, code:number, message:string}}
   */
  function check(req) {
    const h = req.headers || {}
    // 1. Host 白名单
    if (!hostAllowed(h.host)) {
      debug(`面板 Host 白名单拒绝：${String(h.host || '(缺 Host)')}`)
      return { ok: false, code: 403, message: 'Host 不在允许列表（面板安全防护；如用域名访问，请在 config.json 的 security.panel.allowedHosts 里登记）' }
    }
    // 2. 改写型请求的同源证据
    const method = String(req.method || 'GET').toUpperCase()
    if (MUTATING.has(method)) {
      const origin = String(h.origin ?? '').trim()
      if (origin) {
        let originHost = ''
        try { originHost = new URL(origin).host.toLowerCase() } catch { originHost = '' }
        if (!originHost || originHost !== String(h.host ?? '').toLowerCase()) {
          debug(`面板 CSRF 拒绝：Origin=${origin} Host=${String(h.host || '')}`)
          return { ok: false, code: 403, message: '跨站请求被拒绝（CSRF 防护）' }
        }
      } else if (String(h['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
        debug('面板 CSRF 拒绝：Sec-Fetch-Site=cross-site 且无 Origin')
        return { ok: false, code: 403, message: '跨站请求被拒绝（CSRF 防护）' }
      }
      // Origin 与 Sec-Fetch-Site 都没有：非浏览器客户端（curl/脚本/集成测试）
    }
    return { ok: true }
  }

  return { check, hostAllowed }
}
