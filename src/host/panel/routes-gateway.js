// QQ Hub · 面板路由：QQ 网关与 SnowLuma 控制 / 首次向导 / 命令清单 / 更新（host.js 分层拆出）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandList } from '../../chat/commands.js'
import { characterName } from '../../persona/identity-context.js'
import { createUpdateChecker, changelogSection } from '../../core/update.js'

export function registerGatewayRoutes({
  route, readBody, query,
  getConfig, setConfig,
  snowluma, onebot, gatewayState, hub,
  connectionProblem, overview, resetConsent,
  getMods, log,
  pkg, version, root,
}) {
  // 更新：检查 GitHub 上有没有新版本；这次更新了什么
  const checkUpdate = createUpdateChecker({ pkg, log })
  // SnowLuma
  route('/snowluma/start', async () => snowluma.start())
  route('/snowluma/stop', async () => snowluma.stop())
  route('/snowluma/attach', async () => {
    gatewayState.wrongAccount = ''
    snowluma.clearRejected()
    const r = await snowluma.attachBot()
    if (getConfig().enabled && onebot.state === 'stopped') onebot.start()
    return r
  })
  route('/commands', async () => ({ ok: true, list: commandList(getMods().commands()) }))
  route('/update/check', async (req) => checkUpdate({ force: query(req).force === '1' }))
  route('/changelog', async () => {
    let text = ''
    try { text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8') } catch (error) {}
    return { ok: true, version, notes: changelogSection(text, version) }
  })
  route('/snowluma/login-check', async () => ({ ...(await snowluma.canLogin()), passwordAuto: getConfig().snowluma.passwordAuto, running: await snowluma.running() }))
  route('/snowluma/agreements', async () => {
    try { return { ok: true, ...(await snowluma.agreements()) } } catch (error) { return { ok: false, message: error.message } }
  })
  route('/snowluma/consent', async (req) => {
    const b = await readBody(req)
    if (b.agree !== true) return { ok: false, message: '要先勾选「我已阅读并同意」' }
    resetConsent()
    return snowluma.consent(b.version)
  })
  route('/snowluma/reset-password', async () => snowluma.resetPassword())
  // 控制台密码只显示托管状态；明文只能到本机配置文件查看
  route('/snowluma/password', async () => ({ ok: true, configured: Boolean(getConfig().snowluma.webuiPassword), auto: getConfig().snowluma.passwordAuto }))
  route('/snowluma/set-password', async (req) => snowluma.setPassword(String((await readBody(req)).password || '')))
  route('/setup/done', async (req) => {
    const body = await readBody(req)
    const cfg = getConfig()
    if (!cfg.botQQ || !cfg.ownerQQ || cfg.botQQ === cfg.ownerQQ) return { ok: false, message: '先填好不同的机器人 QQ 和你的 QQ' }
    if (body.existingConnection && !(cfg.enabled && gatewayState.onebotState === 'connected' && gatewayState.loginOk)) return { ok: false, message: 'QQ 网关还没通过机器人号核对，请先连接并核对后再进入面板' }
    setConfig({ ...getConfig(), setupDone: true })
    log.info('首次使用向导完成')
    return { ...(await overview()), message: `设置完成，${characterName('', cfg)}可以上线啦` }
  })
  route('/snowluma/processes', async () => {
    try { return { ok: true, list: await snowluma.processes() } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  route('/onebot/reconnect', async () => {
    if (!getConfig().enabled) return { ok: false, message: await connectionProblem() }
    gatewayState.wrongAccount = ''
    onebot.restart()
    // 等几秒看结果，别只回一句「正在重连」
    for (let i = 0; i < 16 && !(gatewayState.onebotState === 'connected' && gatewayState.loginOk); i++) await new Promise((r) => setTimeout(r, 500))
    if (gatewayState.onebotState === 'connected' && gatewayState.loginOk) return { ok: true, message: '连上了' }
    return { ok: false, message: '没连上：' + (await connectionProblem()) }
  })
  route('/onebot/test', async () => {
    try {
      const info = await onebot.call('get_login_info', {}, { timeoutMs: 8000 })
      const uin = String(info?.user_id ?? '')
      const cfg = getConfig()
      return { ok: uin === cfg.botQQ, message: uin === cfg.botQQ ? `连上了：${info.nickname}（${uin}）` : `连上的是 ${uin}，不是机器人号 ${cfg.botQQ}！`, info }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/test-send', async () => {
    const cfg = getConfig()
    if (!cfg.enabled) return { ok: false, message: '先打开总开关' }
    if (cfg.dryRun) return { ok: false, message: '现在是试运行，先关掉试运行再测' }
    const r = await hub.sendText(`private:${cfg.ownerQQ}`, '【QQ Hub 自测】已连通，这是一条自测消息～')
    return r ? { ok: true, message: '发给主人了，去 QQ 看看' } : { ok: false, message: '没发出去（看日志）' }
  })
}
