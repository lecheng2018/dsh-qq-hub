// QQ Hub · 面板路由：目的引擎（host.js 分层拆出）
//
// 统一走 /panel/* 前缀，避免和模块自注册的 /purpose/* 路由撞名；模块缺新接口时
// 降级返回 available:false，面板显示兜底文案不炸。

import { mergeFromPanel } from '../../core/config.js'

export function registerPurposeRoutes({
  route, readBody,
  getConfig, setConfig,
  use, log,
  purposeOverview, redactTokens,
}) {
  route('/panel/purpose/status', async () => ({ ok: true, purpose: purposeOverview() }))
  route('/panel/purpose/preview', async () => {
    const pu = use('purpose')
    if (typeof pu?.preview !== 'function') return { ok: false, available: false, message: '目的引擎模块没在跑，没法预览' }
    return { ok: true, result: redactTokens(await pu.preview()) }
  })
  route('/panel/purpose/run', async () => {
    const pu = use('purpose')
    if (typeof pu?.run !== 'function') return { ok: false, available: false, message: '目的引擎模块没在跑' }
    const r = await pu.run('面板')
    const msg = r && { sent: '已经去找你了', silent: '她这轮想了想，决定不说（不硬发）', muted: '主人在私聊里让她闭嘴了', disabled: '目的引擎开关是关的' }[r.outcome]
    return { ok: !r || r.outcome !== 'disabled', message: msg || (r ? `这轮结束：${r.outcome}` : '没有结果'), result: redactTokens(r) }
  })
  route('/panel/purpose/config', async (req) => {
    const b = await readBody(req)
    const patch = {}
    const extPatch = {}
    if (typeof b.enabled === 'boolean') extPatch.enabled = b.enabled
    if (Object.keys(extPatch).length) patch.ext = { purpose: extPatch }
    const spPatch = {}
    for (const k of ['awakeFrom', 'awakeTo', 'maxPerDay']) if (Number.isFinite(b[k])) spPatch[k] = Math.max(0, Math.floor(b[k]))
    if (Object.keys(spPatch).length) patch.speakUp = spPatch
    if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
    setConfig(mergeFromPanel(getConfig(), patch))
    log.info(`面板已保存目的引擎设置｜${Object.keys(extPatch).map((k) => k + '=' + extPatch[k]).concat(Object.keys(spPatch).map((k) => k + '=' + spPatch[k])).join(' ')}`)
    return { ok: true, purpose: purposeOverview() }
  })
}
