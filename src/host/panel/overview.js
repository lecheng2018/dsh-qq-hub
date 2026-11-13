// QQ Hub · 面板聚合视图（host.js 分层拆出）
//
// /state 的 overview 大聚合 + 目的引擎摘要 + 面板令牌脱敏 + 连不上网关的人话诊断。
// avatarInfo/AVATAR 也在这里（overview 和头像路由两处共用，保持依赖单向：路由层消费本层）。

import { statSync } from 'node:fs'
import { publicConfig } from '../../core/config.js'
import { listPersonas } from '../../persona/personas.js'
import { workspaceDirOf } from '../../chat/workspace.js'
import { DOWNLOAD_PAGE } from '../../snowluma/manager.js'
import { dataDir } from '../../core/store.js'

export function createPanelOverview({
  ctx, getConfig,
  snowluma, onebot, endpoint,
  gatewayState,
  hub, getBridge, getMods,
  use, stickers,
  VERSION, API_VERSION,
}) {
  let consentCache = { at: 0, value: null }
  async function consented(running) {
    if (!running) return null
    if (Date.now() - consentCache.at < 30_000) return consentCache.value
    let value = null
    try { value = !(await snowluma.agreements()).consentRequired } catch (error) {}
    consentCache = { at: Date.now(), value }
    return value
  }
  /** /snowluma/consent 同意后立即失效缓存，下一次 overview 重新查。 */
  function resetConsent() { consentCache = { at: 0, value: null } }

  async function overview() {
    const cfg = getConfig()
    const inst = snowluma.detect()
    const running = inst.installed ? await snowluma.running() : false
    let login = null
    if (gatewayState.onebotState === 'connected') {
      try {
        const info = await onebot.call('get_login_info', {}, { timeoutMs: 5000 })
        login = { uin: String(info?.user_id ?? ''), nickname: info?.nickname || '' }
      } catch (error) {}
    }
    const diary = use('diary')
    const memory = use('memory')
    const bridge = getBridge()
    return {
      ok: true,
      version: VERSION,
      apiVersion: API_VERSION,
      config: publicConfig(cfg),
      onebot: { state: gatewayState.onebotState, login, endpoint: { httpUrl: endpoint().httpUrl, wsUrl: endpoint().wsUrl }, problem: gatewayState.onebotState === 'connected' && gatewayState.loginOk ? '' : await connectionProblem() },
      snowluma: { ...inst, running, consented: await consented(running), owns: snowluma.ownsProcess, lastAttach: snowluma.lastAttach, downloadPage: DOWNLOAD_PAGE, webui: snowluma.webuiUrl() },
      stats: hub.stats(),
      stickers: { count: stickers.library().items.length },
      diary: diary ? { next: diary.nextTime(), last: diary.history()[0] || null } : { next: 0, last: null },
      qzoneSocial: use('qzone-social')?.state?.() ?? null,
      speakUp: use('speakup')?.state?.() ?? { count: 0 },
      purpose: purposeOverview(),
      memory: { lastConsolidate: memory?.lastConsolidate?.() ?? 0 },
      avatar: avatarInfo(),
      voice: { edgeInstalled: use('voice')?.edgeInstalled?.() ?? false },
      sessions: hub.sessions(),
      workspaceDir: workspaceDirOf(cfg),
      personas: listPersonas(),
      modules: getMods().status(),
      bridge: { dshTools: cfg.bridge.dshTools, http: cfg.bridge.http, hasToken: Boolean(cfg.bridge.token), tools: bridge.deniedTools(), toolsService: Boolean(ctx.get?.('tools')) },
    }
  }

  // ---------- 面板：目的机制 聚合 ----------
  // 面板令牌脱敏：任何 32 位以上的十六进制串（模块 host-token、bridge token 等）只留尾 4 位。
  const HEX_RE = /[0-9a-f]{32,}/gi
  function redactTokens(value) {
    const walk = (v) => typeof v === 'string' ? v.replace(HEX_RE, (m) => '（已脱敏…' + m.slice(-4) + '）')
      : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => /token|secret/i.test(k) && typeof x === 'string' && x ? [k, '（已脱敏…' + String(x).slice(-4) + '）'] : [k, walk(x)]))
      : v
    return walk(value)
  }
  // 「目的引擎」聚合：purpose 是默认关的独立内置模块，没开时 available=false，面板显示引导文案，不报错。
  // 安静时段真相 = speakUp 醒着窗口（与 purpose/module.js 的 purposeConfig 派生保持一致）。
  function purposeOverview() {
    const pu = use('purpose')
    const cfg = getConfig()
    const ext = (cfg.ext && cfg.ext.purpose) || {}
    const sp = cfg.speakUp || {}
    const pad2 = (n) => String(n % 24).padStart(2, '0')
    const awakeFrom = Number.isFinite(sp.awakeFrom) ? sp.awakeFrom : 8
    const awakeTo = Number.isFinite(sp.awakeTo) ? sp.awakeTo : 23
    const quiet = awakeTo >= 24 || awakeFrom >= awakeTo ? { quietStart: '00:00', quietEnd: '00:00' } : { quietStart: pad2(awakeTo) + ':00', quietEnd: pad2(awakeFrom) + ':00' }
    return {
      available: typeof pu?.status === 'function',
      enabled: ext.enabled === true,
      status: pu?.status?.() ?? null,
      count: pu?.state?.().count ?? 0,
      quietStart: quiet.quietStart,
      quietEnd: quiet.quietEnd,
      dailyMax: Number.isFinite(sp.maxPerDay) ? sp.maxPerDay : null,
      awakeFrom,
      awakeTo,
    }
  }

  /** 连不上 QQ 网关时，按顺序找卡在哪一步，给一句人话。 */
  async function connectionProblem() {
    const cfg = getConfig()
    if (!cfg.enabled) return '总开关关着（右上角），打开后才会连'
    if (!cfg.botQQ) return '还没填机器人 QQ 号'
    if (cfg.gateway === 'onebot') {
      const ep = endpoint()
      if (!ep.wsUrl) return '还没填 OneBot 的 WebSocket 地址：在「连接」页填你的 OneBot v11 正向 WebSocket 地址（收消息要靠它；HTTP 可以不填）'
      if (gatewayState.wrongAccount) return `连上的是 ${gatewayState.wrongAccount}，不是机器人号 ${cfg.botQQ}，已经断开：让你的 OneBot 服务登录机器人号，再点「重新连接」`
      return `连 ${ep.wsUrl || ep.httpUrl} 没连上：确认你的 OneBot 服务开着、地址和 token 填对了（Docker 里的话，地址要用 DSH 能访问到的主机名 / 端口）`
    }
    const inst = snowluma.detect()
    if (!inst.installed && !(cfg.snowluma.wsUrl || cfg.snowluma.httpUrl)) return 'SnowLuma 没装好：' + inst.reason
    if (inst.installed && !(await snowluma.running())) return 'SnowLuma 没在运行：点上面的「启动」'
    if (snowluma.lowIntegrity) return 'SnowLuma 以「低完整性」运行，看不到 QQ 进程（多半是解压在了下载目录这类带安全标签的地方）：把它重新解压到一个普通目录（比如 D:\\SnowLuma），在「连接」页改好目录再启动'
    const ep = endpoint()
    if (!ep.wsUrl && !ep.httpUrl) return 'SnowLuma 还没给机器人号开 OneBot 端口，也就是机器人号还没接入：确认机器人号的 QQ 已经登录，再点「接入机器人号」'
    if (gatewayState.wrongAccount) return `连上的是 ${gatewayState.wrongAccount}，不是机器人号 ${cfg.botQQ}，已经断开：只登着机器人号那个 QQ，再点「接入机器人号」`
    const la = snowluma.lastAttach
    if (la && la.at && !la.ok && la.message) return '接入机器人号没成功：' + la.message
    return `连 ${ep.wsUrl || ep.httpUrl} 没连上：确认机器人号的 QQ 开着、已经登录，并且 SnowLuma 控制台里这个号显示已接入`
  }

  // 头像：自定义的放在数据目录（重装插件不丢），没有就用插件自带的大肥鱼
  const AVATAR = () => dataDir('avatar.img')
  const avatarInfo = () => {
    try { return { custom: true, at: statSync(AVATAR()).mtimeMs } } catch (error) { return { custom: false, at: 0 } }
  }

  return { overview, purposeOverview, redactTokens, connectionProblem, consented, resetConsent, avatarInfo, avatarPath: AVATAR }
}
