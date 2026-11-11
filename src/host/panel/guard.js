// QQ Hub · 面板入站防护：Host 白名单、CSRF、副作用方法约束与管理请求鉴权
//
// 背景（M1-A 侦察结论，2026-11-08）：
//   多数面板路由此前只有 Host/CSRF 防护；少数敏感接口和 /open/* 已单独校验 bridge 密钥。
//   DSH 外层 webServer 是否限制监听地址/来源属部署形态（fnOS 实测留 M5），
//   插件层按「无则补齐」统一 Host/CSRF、副作用方法和管理请求鉴权，同时保留合法只读访问：
//
//   1. Host 白名单（挡 DNS rebinding + 跨站伪造指向）：
//      只接受 回环名（localhost/127.0.0.1/[::1]/::1）、IP 字面量（v4/v6，含端口），
//      以及 config.security.panel.allowedHosts 里显式配置的域名（如 fnOS 的 DDNS 名）。
//      rebinding 攻击的请求 Host 是攻击者域名（evil.com），直接 403；
//      用 IP 访问面板的正常习惯不受影响。缺 Host 头（HTTP/1.1 必带）视为可疑 403。
//
//   2. 同源校验（挡跨站 CSRF，P1 §4.9 收紧）：
//      只要带 Origin 就必须与 Host 一致——任何方法都查（旧版只对 POST/PUT/DELETE/PATCH 查，
//      跨站 fetch/img 带跨源 Origin 的 GET 能绕过；同域 fetch 带同源 Origin 不受影响，
//      浏览器顶层导航 GET 不带 Origin 也不受影响）；
//      带改写型方法（POST/PUT/DELETE/PATCH）且没有 Origin 时看 Sec-Fetch-Site（cross-site 403）；
//      两者都没有 = 非浏览器客户端（curl/脚本/测试），放行——CSRF 只能由浏览器发起，
//      浏览器一定留下上述证据之一。
//
//   2.5 副作用路径只认提交方法（P1 §4.9 主修）：面板有大批「有副作用但曾挂 GET 也能触发」的
//      接口（发测试消息、重置会话、启停进程、删数据…，逐个处理器判定，见下面
//      SIDE_EFFECT_PATHS 的行内注释）。这类路径遇到 GET/HEAD 等非提交方法一律 405，不进 handler
//      ——挡住「跨站 <img src=…>/顶层链接点一下」这类不带 Origin 的无状态触发；
//      面板前端（client/client.js）对这些全部走 POST，合法流程不受影响；
//      curl/脚本用户同样需要 POST（-X POST）。只读路径（/state /logs /avatar…）仍允许 GET。
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
// 面板接口前缀（host.js 的 PREFIX）：路由都按「前缀 + 子路径」登记，判定前先剥掉
const DEFAULT_PREFIX = '/qq-hub/api'

// 副作用路径全集（相对前缀的子路径；逐个处理器按「写持久状态 / 对外发消息 / 启停或派生进程 /
// 删数据 / 真执行代码或触发外部计费调用」判定，只读处理器不收）。
// 行号 = 注册处（routes-*.js），注释 = 副作用依据。
const SIDE_EFFECT_PATHS = new Set([
  // routes-config.js
  '/save',                 // :70 setConfig + 网关重启 + 会话重置 + SnowLuma 改密
  '/sessions/reset',       // :119 hub.resetSessions 归档全部会话
  '/workspaces/delete',    // :31 收会话 + reg.delete 删工作区
  // routes-gateway.js
  '/snowluma/start',       // :19 起进程
  '/snowluma/stop',        // :20 停进程
  '/snowluma/attach',      // :21 attachBot 登录接入 + 可能 onebot.start
  '/snowluma/consent',     // :39 resetConsent + snowluma.consent 写同意记录
  '/snowluma/reset-password', // :45 重置控制台密码
  '/snowluma/set-password',   // :48 改控制台密码
  '/setup/done',           // :49 setConfig（setupDone）
  '/onebot/reconnect',     // :61 onebot.restart
  '/test-send',            // :80 hub.sendText 给主人发 QQ 消息
  // routes-persona.js
  '/persona/save',         // :20 savePersona 写文件 + 重置会话
  '/persona/delete',       // :35 deletePersona 删文件
  '/persona/use',          // :41 setConfig + 重置会话
  '/persona/polish',       // :60 askModel 外部计费调用（仅面板 POST 用）
  // routes-purpose.js
  '/panel/purpose/run',    // :20 跑一轮目的引擎（可能真的发 QQ 消息）
  '/panel/purpose/config', // :27 setConfig
  // routes-modules.js
  '/memory/reload',
  '/modules/reload',       // :17 重新加载并执行模块代码
  '/modules/create',       // :23 写模块目录
  '/modules/fork',         // :29 复制模块目录
  '/modules/open',         // :36 spawn explorer
  '/modules/simulate',     // :49 执行模块命令/钩子代码
  '/modules/tool',         // :83 真执行工具（可能落 onebot 操作）
  // routes-misc.js
  '/local/open',           // :30 spawn explorer
  '/local/test',           // :31 跑本地 tts/image 脚本、产文件
  '/local/template',       // :25 mkdir + copyFileSync 写模板文件
  '/bridge/token/reset',   // 仅保留 GET 类方法约束；密钥禁止通过 API 轮换
  '/open/send',            // :59 bridge.ops.send 发 QQ 消息
  '/open/think',           // :60 bridge.ops.think 起系统轮次、可能投递回复
  '/open/call',            // :61 bridge.ops.call 调任意模块函数
  '/models/apply',         // :65 syncAllModels 切换所有会话模型
  '/model/ping',           // :88 askModel 外部计费调用（仅面板 POST 用）
  '/avatar/upload',        // :109 writeFileSync 换头像
  '/avatar/reset',         // :119 unlinkSync 删头像
  '/avatar/sync-qq',       // :123 set_qq_avatar 改 QQ 头像
])

/** 从 Host 头里剥出主机名（处理 '127.0.0.1:8080' 与 '[::1]:8080' 两种形态）。 */
export function hostNameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase()
  if (!raw) return ''
  const bracket = raw.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracket) return bracket[1]
  const hostPort = raw.match(/^([^:]+):(\d+)$/) // 无括号 host:port（host 内不含冒号）
  return hostPort ? hostPort[1] : raw
}

/** 取请求路径里「剥前缀、去查询串、去尾斜杠」后的子路径（匹配 SIDE_EFFECT_PATHS 的键形态）。 */
function subPath(req, prefix) {
  const raw = String(req.url ?? '')
  let p = raw
  try { p = new URL(raw, 'http://x').pathname } catch { p = raw.split('?')[0].split('#')[0] }
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length)
  p = p.replace(/\/+$/, '')
  return p.startsWith('/') ? p : ''
}

export function createPanelGuard({ getConfig, log, prefix = DEFAULT_PREFIX, isAuthorized }) {
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
    // 2. 同源证据：带 Origin 就必须与 Host 一致——不分方法（P1 §4.9：旧版只管改写方法，
    //    跨站 fetch/img/prefetch 带跨源 Origin 的 GET 全绕过了；同域 fetch 带同源 Origin、
    //    顶层导航不带 Origin，都不受影响；Origin 解析失败按 fail-closed 拒）
    const method = String(req.method || 'GET').toUpperCase()
    const origin = String(h.origin ?? '').trim()
    if (origin) {
      let originHost = ''
      try { originHost = new URL(origin).host.toLowerCase() } catch { originHost = '' }
      if (!originHost || originHost !== String(h.host ?? '').toLowerCase()) {
        debug(`面板 CSRF 拒绝：Origin=${origin} Host=${String(h.host || '')} method=${method}`)
        return { ok: false, code: 403, message: '跨站请求被拒绝（CSRF 防护）' }
      }
    }
    // 3. 改写型请求且没带 Origin：cross-site 证据（Sec-Fetch-Site）直接拒；两者都没有 = 非浏览器客户端（curl/脚本/测试）
    else if (MUTATING.has(method) && String(h['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
      debug('面板 CSRF 拒绝：Sec-Fetch-Site=cross-site 且无 Origin')
      return { ok: false, code: 403, message: '跨站请求被拒绝（CSRF 防护）' }
    }
    const path = subPath(req, prefix)
    // 4. 副作用路径只认提交方法：GET/HEAD/OPTIONS/TRACE 等非提交方法一律 405，不进 handler
    //    （挡掉不带 Origin 的 <img>/顶层链接/prefetch 式触发；面板前端对这些全部用 POST）
    if (!MUTATING.has(method) && SIDE_EFFECT_PATHS.has(path)) {
      debug(`面板副作用路径拒 GET 类方法：${method} ${path}`)
      return { ok: false, code: 405, message: `这个接口有副作用，不接受 ${method} 触发（请通过面板按钮以 POST 调用）` }
    }
    // 面板管理请求均需联动密钥；开放 HTTP API 的只读接口原本也要求密钥，维持其保护。
    if ((MUTATING.has(method) || path === '/open' || path.startsWith('/open/')) && isAuthorized && !isAuthorized(req)) {
      debug(`面板管理请求鉴权失败：${method} ${path}`)
      return { ok: false, code: 401, message: '需要有效联动密钥' }
    }
    if (path === '/bridge/token/reset') {
      debug('面板联动密钥禁止通过 API 重置')
      return { ok: false, code: 403, message: '联动密钥不能通过面板 API 重置，请在本机配置文件中修改' }
    }
    return { ok: true }
  }

  return { check, hostAllowed }
}
