// 内置模块：在线与已读。把「她在线」这件事做得像个人：
//   · 已读上报：收到消息后（可配延迟）mark_all_as_read——对方看得到「已读」，但她不回就是不回；
//   · 在线状态：网关连上/配置变化时设自定义在线状态文字（QQ 端资料卡可见）。
//
// 边界（如实）：
//   · mark_all_as_read 是**账号级**的，不是单聊级——延迟合并成一次调用，省网关 chatter；
//   · DIY 在线状态没有「清除」动作目录项，/在线 关 只停掉自动设置，QQ 端已有状态要手机上手动取消；
//   · 这两个动作都是状态写（非只读），不进 read-actions 白名单——失败不重试，如实记日志。
//
// 内存/定时器纪律：全局只有一个 debounce 计时器（unref），dispose 清；lastApplied 是一个字符串，无表。

import { registerReadActions } from '../../onebot/read-actions.js'

/**
 * 已读上报的防抖器（纯逻辑，定时器注入便于测试）。
 * 同一窗口内多条消息只调一次 mark_all_as_read；dispose 时撤掉挂起的计时器。
 */
export function createReadDebouncer({ call, delayMs = 1500, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let timer = null
  let disposed = false
  return {
    /** 收到一条入站消息。窗口内重复调用只保留一次。 */
    note() {
      if (disposed || timer) return
      timer = setTimeoutFn(() => {
        timer = null
        call().catch(() => {})
      }, Number(delayMs) || 1500)
      timer.unref?.()
    },
    /** 还挂着待上报（测试用）。 */
    pending() { return timer !== null },
    dispose() {
      disposed = true
      if (timer) { clearTimeoutFn(timer); timer = null }
    },
  }
}

/** DIY 在线状态参数整形：文字非空才给参数（防御式：两个常见字段名都带上，网关各取所需）。 */
export function pickStatusParams(text) {
  const t = String(text ?? '').trim().slice(0, 60)
  if (!t) return null
  return { status_text: t, text: t }
}

export default {
  id: 'online-status',
  name: '在线与已读',
  version: '1.0.0',
  tab: 'enhance',
  description: '收到消息后上报已读（可配延迟）；网关连上时设置自定义在线状态文字',
  defaults: {
    markReadEnabled: false,
    markReadDelayMs: 1500,
    onlineStatusEnabled: false,
    onlineStatusText: '',
  },
  settings: [
    { key: 'markReadEnabled', label: '上报已读', type: 'switch', hint: '收到消息后约 1.5 秒把账号消息标为已读（账号级）。注意：即使她最后没回，对方也看得到已读' },
    { key: 'markReadDelayMs', label: '已读延迟 (毫秒)', type: 'number', min: 500, max: 10000, step: 250, hint: '一批消息合并成一次上报' },
    { key: 'onlineStatusEnabled', label: '自定义在线状态', type: 'switch', hint: '网关连上时把在线状态设成下面的文字（QQ 端资料卡可见）' },
    { key: 'onlineStatusText', label: '状态文字', type: 'text', placeholder: '在线，可喊', hint: '最长 60 字；改完保存即重设' },
  ],
  setup(api) {
    const { onebot } = api.core

    // 状态写动作不进只读白名单（保守：失败不重试）。
    registerReadActions([]) // 显式空登记：保持口径一致，也验证注册表可用

    const settingsOf = () => {
      const s = api.settings() || {}
      return {
        markReadEnabled: s.markReadEnabled === true,
        markReadDelayMs: Math.max(500, Math.min(10000, Number(s.markReadDelayMs) || 1500)),
        onlineStatusEnabled: s.onlineStatusEnabled === true,
        onlineStatusText: String(s.onlineStatusText ?? '').trim(),
      }
    }

    // ---- 已读上报：账号级 + 防抖合并 ----
    let debouncer = null
    const rebuildDebouncer = () => {
      debouncer?.dispose()
      const s = settingsOf()
      debouncer = s.markReadEnabled
        ? createReadDebouncer({
          delayMs: s.markReadDelayMs,
          call: () => onebot.call('mark_all_as_read', {}, { timeoutMs: 5000 }),
        })
        : null
    }
    rebuildDebouncer()
    api.onDispose?.(() => { debouncer?.dispose(); debouncer = null })

    api.on('activity', ({ kind } = {}) => {
      if (kind !== 'in') return
      if (!settingsOf().markReadEnabled || !debouncer) return
      debouncer.note()
    })

    // ---- 在线状态：连上时 + 配置变化时，幂等重设 ----
    let lastApplied = ''
    async function applyStatus(reason) {
      const s = settingsOf()
      if (!s.onlineStatusEnabled || !s.onlineStatusText) return
      if (s.onlineStatusText === lastApplied) return
      const params = pickStatusParams(s.onlineStatusText)
      if (!params) return
      try {
        await onebot.call('set_diy_online_status', params, { timeoutMs: 8000 })
        lastApplied = s.onlineStatusText
        api.log.info(`在线状态已设置：${s.onlineStatusText}${reason ? `（${reason}）` : ''}`)
      } catch (error) {
        // 不重试：状态设不上去不是致命事，配置页能看到日志
        api.log.warn(`在线状态没设上（${reason || 'setup'}）：`, error?.message || error)
      }
    }

    // 网关连上时先试一次；断开重连由 onebot/state 事件再触发
    api.on('onebot/state', (state) => {
      if (state === 'connected') { lastApplied = ''; applyStatus('网关连上').catch(() => {}) }
    })
    api.on('config', () => { rebuildDebouncer(); applyStatus('配置变化').catch(() => {}) })
    // 启动时如果网关已经在线（模块重载场景），也设一次
    Promise.resolve().then(() => applyStatus('模块启动').catch(() => {}))

    // 主人命令：/在线 <文字> 直接设（含开关）；/在线 关 只停自动设置
    api.command({
      name: '在线',
      desc: '设置自定义在线状态文字；「关」停掉自动设置',
      run: async (arg) => {
        const text = String(arg || '').trim()
        if (!text) return '用法：/在线 <状态文字>，或 /在线 关'
        if (text === '关') {
          await api.saveSettings({ onlineStatusEnabled: false })
          return '自动设置停了。QQ 端已有的状态要在手机上手动取消。'
        }
        await api.saveSettings({ onlineStatusEnabled: true, onlineStatusText: text })
        const params = pickStatusParams(text)
        try {
          await onebot.call('set_diy_online_status', params, { timeoutMs: 8000 })
          return `在线状态设好了：${text}`
        } catch (error) {
          return `设置存了，但网关没接受：${String(error?.message || error).slice(0, 100)}`
        }
      },
    })

    return { applyStatus, pickStatusParams }
  },
}
