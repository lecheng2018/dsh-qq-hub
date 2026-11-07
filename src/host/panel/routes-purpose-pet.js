// QQ Hub · 面板路由：目的引擎 / 桌宠代理（host.js 分层拆出）
//
// 统一走 /panel/* 前缀，避免和模块自注册的 /purpose/*、/pet/* 路由撞名；模块缺新接口时
// 降级返回 available:false，面板显示兜底文案不炸。

import { mergeFromPanel } from '../../core/config.js'

export function registerPurposePetRoutes({
  route, readBody,
  getConfig, setConfig,
  use, log,
  purposeOverview, petStatus, redactTokens,
}) {
  route('/panel/purpose/status', async () => ({ ok: true, purpose: purposeOverview(), pet: petStatus() }))
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
    if (b.carrier === 'qq' || b.carrier === 'pet') extPatch.carrier = b.carrier
    if (typeof b.petFallbackToQQ === 'boolean') extPatch.petFallbackToQQ = b.petFallbackToQQ
    if (Object.keys(extPatch).length) patch.ext = { purpose: extPatch }
    const spPatch = {}
    for (const k of ['awakeFrom', 'awakeTo', 'maxPerDay']) if (Number.isFinite(b[k])) spPatch[k] = Math.max(0, Math.floor(b[k]))
    if (Object.keys(spPatch).length) patch.speakUp = spPatch
    if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
    setConfig(mergeFromPanel(getConfig(), patch))
    log.info(`面板已保存目的引擎设置｜${Object.keys(extPatch).map((k) => k + '=' + extPatch[k]).concat(Object.keys(spPatch).map((k) => k + '=' + spPatch[k])).join(' ')}`)
    return { ok: true, purpose: purposeOverview() }
  })
  route('/panel/pet/status', async () => ({ ok: true, pet: petStatus() }))
  // 桌宠页下方的设置项：碎碎念（桌宠自己的气泡流）+ 干活状态动画/结束提醒
  route('/panel/pet/config', async (req) => {
    const b = await readBody(req)
    const patch = {}
    for (const k of ['whisperEnabled', 'whisperPauseOnPetCarrier', 'workStatusEnabled', 'workBubble', 'workNotify']) {
      if (typeof b[k] === 'boolean') patch[k] = b[k]
    }
    if (b.whisperSource === 'model' || b.whisperSource === 'pool') patch.whisperSource = b.whisperSource
    for (const k of ['whisperMinMinutes', 'whisperMaxMinutes', 'whisperMaxPerDay']) {
      // 面板口径：间隔 1~9999 分钟、每日上限 0~9999 次（0 = 不发）
      if (Number.isFinite(b[k])) patch[k] = k === 'whisperMaxPerDay' ? Math.min(9999, Math.max(0, Math.floor(b[k]))) : Math.min(9999, Math.max(1, Math.floor(b[k])))
    }
    if (typeof b.whisperLines === 'string') patch.whisperLines = b.whisperLines.slice(0, 4000)
    // 行为大脑的模块级设置（AI 自己改不了，只有主人能改）。pet 是**内置模块**，
    // 它的 settings schema 不会渲染成表单（面板只给「用户自己复制出来的模块」生成），
    // 所以这里是这些开关唯一的写入通道——不补，关窗物理闸就永远打不开。
    for (const k of ['behaviorEnabled', 'behaviorIconMischiefEnabled', 'behaviorCloseWindowEnabled']) {
      if (typeof b[k] === 'boolean') patch[k] = b[k]
    }
    for (const [k, lo, hi] of [
      ['behaviorMinMinutes', 1, 9999],        // 铁律：最短 1 分钟
      ['behaviorMaxMinutes', 1, 9999],
      ['behaviorMaxPerDay', 0, 999999],
      ['behaviorIdleCursorMinutes', 1, 240],
      ['behaviorMoodCloseWindowBelow', 0, 100],
      ['behaviorIconQuarantineDays', 1, 365],
    ]) {
      if (Number.isFinite(b[k])) patch[k] = Math.min(hi, Math.max(lo, Math.round(b[k])))
    }
    if (typeof b.behaviorWindowWhitelist === 'string') patch.behaviorWindowWhitelist = b.behaviorWindowWhitelist.slice(0, 2000)
    if (typeof b.behaviorDisabledActions === 'string') patch.behaviorDisabledActions = b.behaviorDisabledActions.slice(0, 500)
    if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
    setConfig(mergeFromPanel(getConfig(), { ext: { pet: patch } }))
    log.info(`面板已保存桌宠设置｜${Object.keys(patch).map((k) => k + '=' + String(patch[k]).slice(0, 20)).join(' ')}`)
    return { ok: true, pet: petStatus() }
  })
  // 「现在碎碎念一句」：绕过排程与开关，但仍尊重专注模式（force 只跳排程类闸门）
  route('/panel/pet/whisper', async (req) => {
    const pet = use('pet')
    if (typeof pet?.whisperNow !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，碎碎念不了' }
    const r = await pet.whisperNow({ force: true, reason: '面板' })
    const msg = r && r.ok ? `她嘟囔了一句：${r.text}` : ({ focus: '专注模式开着，先关掉再来', 'pet-offline': '桌宠没在跑，气泡发不出去', 'plugin-off': '插件总开关是关的', thinking: '上一句她还在想（工作区那条会话还没结束），等几秒再来' }[r && r.reason] || '这轮没说出来')
    return { ok: Boolean(r && r.ok), message: msg, result: redactTokens(r) }
  })
  route('/panel/pet/download', async () => {
    const pet = use('pet')
    if (typeof pet?.download !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，装不了客户端' }
    return { ok: true, result: redactTokens(await pet.download()) }
  })
  route('/panel/pet/focus', async (req) => {
    const enabled = Boolean((await readBody(req)).enabled)
    const pet = use('pet')
    if (typeof pet?.setFocus !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，改不了专注模式' }
    return { ok: true, result: redactTokens(await pet.setFocus(enabled)) }
  })
  // Electron 三键：安装（npmmirror 镜像）→ 启动（清 ELECTRON_RUN_AS_NODE 分离进程）→ 停止（杀 pid）
  route('/panel/pet/electron-install', async () => {
    const pet = use('pet')
    if (typeof pet?.electronInstall !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，装不了 Electron' }
    return { ok: true, result: redactTokens(await pet.electronInstall()) }
  })
  route('/panel/pet/launch', async () => {
    const pet = use('pet')
    if (typeof pet?.launch !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，启动不了桌宠' }
    return { ok: true, result: redactTokens(await Promise.resolve(pet.launch())) }
  })
  route('/panel/pet/stop', async () => {
    const pet = use('pet')
    if (typeof pet?.stop !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，停不了桌宠' }
    return { ok: true, result: redactTokens(await Promise.resolve(pet.stop())) }
  })
  // ---------- 行为动作（设计稿 §8 测试通道）：面板「试一下」+ 每动作 AI 开关 + 图标隔离区 ----------
  // 全部代理到 pet 模块已暴露的函数（behaviorEmit / behaviorStatus / iconQuarantine / iconRestore）；
  // 模块没就绪或旧版本缺接口时降级 available:false，面板显示兜底文案不炸。
  route('/panel/pet/behavior/status', async () => {
    const pet = use('pet')
    if (typeof pet?.behaviorStatus !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪' }
    return { ok: true, behavior: redactTokens(pet.behaviorStatus()) }
  })
  // 「试一下」：手动触发默认 force=true（绕排程/专注/安静时段；桌宠离线时回执会显示 refused/failed）
  route('/panel/pet/behavior', async (req) => {
    const b = await readBody(req)
    const pet = use('pet')
    if (typeof pet?.behaviorEmit !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，试不了' }
    const r = await pet.behaviorEmit({ action: b.action, params: b.params, say: b.say, force: b.force !== false, reason: 'panel' })
    const why = {
      'unknown-action': '没有这个动作',
      'emit-failed': '下发失败（看日志）',
      // 关窗物理闸：说清去哪里开，否则面板上只看到「这轮没演成」
      'close-window-disabled': '先在「行为与安全」卡里打开「允许 AI 关闭窗口」（物理闸，手动「试一下」也绕不过）',
      'empty-text': '「说话」动作要给一句台词再试',
    }
    return {
      ok: Boolean(r && r.ok),
      reason: (r && r.reason) || '',
      message: r && r.ok
        ? `已下发「${r.action}」${r.say ? `：${r.say}` : ''}，桌宠在跑就会演`
        : (why[r?.reason] || '这轮没演成'),
      result: redactTokens(r),
    }
  })
  // 每动作「进不进 AI 动作表」：写 ext.pet.behaviorDisabledActions（逗号分隔），与模块 settings 单一真相
  route('/panel/pet/behavior/actions', async (req) => {
    const b = await readBody(req)
    const action = String(b.action || '').trim().slice(0, 40)
    if (!action) return { ok: false, message: '缺动作名' }
    // 动作名白名单（来自模块的全表）：防止手滑/旧面板把垃圾动作名写进配置
    try {
      const st = use('pet')?.behaviorStatus?.()
      const known = new Set([...(st?.openActions || []), ...(st?.deferredActions || [])])
      if (known.size && !known.has(action)) return { ok: false, message: '没有这个动作：' + action }
    } catch (error) { /* 模块没就绪就不校验，别把开关卡死 */ }
    const cur = new Set(String(getConfig().ext?.pet?.behaviorDisabledActions || '').split(',').map((x) => x.trim()).filter(Boolean))
    if (b.on === false) cur.add(action); else cur.delete(action)
    setConfig(mergeFromPanel(getConfig(), { ext: { pet: { behaviorDisabledActions: [...cur].join(',') } } }))
    log.info(`面板已改 AI 动作表｜${action} → ${b.on === false ? '禁用' : '启用'}`)
    return { ok: true, disabledActions: [...cur] }
  })
  // 图标隔离区清单：{items:[{id,name,originalPath,at,reason}]}
  route('/panel/pet/behavior/quarantine', async () => {
    const pet = use('pet')
    if (typeof pet?.iconQuarantine !== 'function') return { ok: false, available: false, message: '图标隔离区接口还没就绪' }
    try { return { ok: true, items: pet.iconQuarantine() || [] } } catch (error) { return { ok: false, available: false, message: '隔离区清单读不了：' + String(error?.message || error) } }
  })
  // 「放回去」：rename 回原路径（原位置被占则改名），失败按原因给人话，别让面板只挂一句「没放回去」
  route('/panel/pet/behavior/restore', async (req) => {
    const b = await readBody(req)
    const pet = use('pet')
    if (typeof pet?.iconRestore !== 'function') return { ok: false, available: false, message: '归还接口还没就绪' }
    const r = await pet.iconRestore(String(b.id || '').slice(0, 64))
    const why = { 'not-found': '隔离区里没有这条记录（可能已经放回去了）', 'quarantine-file-gone': '隔离区里的文件已经不在了，这条记录已清掉', 'restore-failed': '放回去失败（看日志）' }
    return { ok: Boolean(r && r.ok), message: r && r.ok ? `「${r.name}」放回去了` : (why[r?.reason] || '没放回去：原位置可能没了，或图标已经被移走'), result: redactTokens(r) }
  })

  // 第三批：补偿道歉（心情 +8，并标记最近一条未道歉的关窗记录；不删记录）
  route('/panel/pet/behavior/apologize', async () => {
    const pet = use('pet')
    if (typeof pet?.windowApologize !== 'function') return { ok: false, available: false, message: '道歉接口还没就绪' }
    try {
      const r = pet.windowApologize()
      return {
        ok: Boolean(r && r.ok),
        message: r && r.ok ? (r.window ? `她为「${r.window}」道了歉` : '她道了歉') : '没有需要道歉的记录',
        result: redactTokens(r),
      }
    } catch (error) { return { ok: false, message: '道歉没成功：' + String(error?.message || error) } }
  })
}
