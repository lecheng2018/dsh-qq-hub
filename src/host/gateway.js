// QQ Hub · QQ 网关连接层（host.js 分层拆出）
//
// OneBot 客户端创建 + 连接状态机 + 机器人号核对 + 事件分发 + 断线补收触发。
// 状态（onebotState/loginOk/wrongAccount/verifying/pendingEvents/backfilling）全部
// 收编在本工厂闭包里，面板经 state 只读消费（wrongAccount 提供写入口，/save、
// /snowluma/attach、/onebot/reconnect 要清它）。
//
// 核对期间收到的事件先攒着：核对通过就补处理，核对失败就丢掉。
// 直接丢弃的话，刚连上那几百毫秒里主人发的消息就没了（登录核对要等一次 get_login_info 往返）。

import { createOneBotClient } from '../onebot/client.js'
import { createUpstreamGapTracker, createSeenMessageIds, selectBackfill, describeDuration } from '../chat/backfill.js'
import { dataDir } from '../core/store.js'

export function createGateway({
  getConfig, snowluma, endpoint, logger, log,
  getHub, getMods, getDangerGuard,
  dispatch, // (ev, kind) => Promise；kind 'message'|'poke'，由组合根决定走管道还是遗留 hub
}) {
  let onebotState = 'stopped'
  // 连上后先核对登录的是不是机器人号，核对通过前不处理任何消息；不是就断开，不再自动重连
  let loginOk = false
  let wrongAccount = ''
  let verifying = false
  let pendingEvents = []

  // 断线消息补收（Backfill）追踪器
  const gapTracker = createUpstreamGapTracker({
    file: dataDir('upstream-seen.json'),
    gapMs: Number(getConfig().backfill?.gapMs) || 120_000,
    onError: (err) => log.debug('gapTracker 出错:', err.message)
  })
  const seenIds = createSeenMessageIds()
  let backfilling = false

  async function triggerBackfill({ since, gapMs }) {
    if (backfilling || getConfig().backfill?.enabled === false) return
    backfilling = true
    const cfg = getConfig()
    const settle = Number(cfg.backfill?.settleMs) || 10_000
    if (settle > 0) await new Promise((r) => setTimeout(r, settle))
    try {
      log.info(`[backfill] 发现连接断档约 ${describeDuration(gapMs)}，开始拉取错过的历史消息...`)
      const groups = (cfg.allow?.groups || []).map(String)
      const privates = (cfg.allow?.private || []).map(String)
      const botQQ = String(cfg.botQQ || '')

      for (const gid of groups) {
        try {
          const res = await onebot.call('get_group_msg_history', { group_id: Number(gid), count: 30 })
          const msgs = Array.isArray(res?.messages) ? res.messages : []
          const { items } = selectBackfill(msgs, {
            key: `group:${gid}`,
            since,
            selfId: botQQ,
            seen: seenIds,
            config: cfg.backfill
          })
          for (const it of items) {
            seenIds.add(`group:${gid}`, it.event.message_id)
            // M1-B：过旧（> maxAgeMinutes）消息不主动唤醒——backfill.js 头注安全承诺 #3。
            // 它们只留在 QQ 自己的历史里；legacy 没有独立的「只落上下文」通道，
            // 投喂 6 小时前的旧消息只会制造迟到副作用（M1-B 验收线），故整个跳过。
            // 新核心 M2-A 起由 NormalizedInbound.source + 时间戳承接「落上下文」语义。
            if (it.tooOld) { log.debug(`[backfill] 群 ${gid} 消息 ${it.event.message_id} 过旧（${Math.round(it.ageMs / 60000)} 分钟），只记录不唤醒`); continue }
            await getHub().onMessage(it.event, { backfill: true, gapMs, earliestAgeMs: it.ageMs })
          }
        } catch (e) {
          log.debug(`[backfill] 拉取群 ${gid} 历史失败:`, e.message)
        }
      }
      for (const uid of privates) {
        try {
          const res = await onebot.call('get_friend_msg_history', { user_id: Number(uid), count: 20 })
          const msgs = Array.isArray(res?.messages) ? res.messages : []
          const { items, skippedCommands } = selectBackfill(msgs, {
            key: `private:${uid}`,
            since,
            selfId: botQQ,
            seen: seenIds,
            config: cfg.backfill
          })
          // M1-B：命令/审批/动态码在补收中绝不执行；记入 seen，重复拉取时不再重发提醒
          for (const c of skippedCommands) seenIds.add(`private:${uid}`, c.event.message_id)
          if (skippedCommands.length && String(uid) === String(cfg.ownerQQ)) {
            const cmds = skippedCommands.map((c) => `「${c.text}」`).join('、')
            await getHub().sendText(`private:${uid}`, `⚠️ 断线期间（约 ${describeDuration(gapMs)}）收到的管理命令 ${cmds} 未执行；如需执行请重新发送。`)
          }
          for (const it of items) {
            seenIds.add(`private:${uid}`, it.event.message_id)
            // M1-B：同上，过旧消息不唤醒
            if (it.tooOld) { log.debug(`[backfill] 私聊 ${uid} 消息 ${it.event.message_id} 过旧（${Math.round(it.ageMs / 60000)} 分钟），只记录不唤醒`); continue }
            await getHub().onMessage(it.event, { backfill: true, gapMs, earliestAgeMs: it.ageMs })
          }
        } catch (e) {
          log.debug(`[backfill] 拉取私聊 ${uid} 历史失败:`, e.message)
        }
      }
    } catch (err) {
      log.warn('[backfill] 补收历史消息异常:', err.message)
    } finally {
      backfilling = false
    }
  }

  async function checkLogin() {
    verifying = true
    pendingEvents = []
    try {
      let uin = ''
      try {
        const info = await onebot.call('get_login_info', {}, { timeoutMs: 10000 })
        uin = String(info?.user_id ?? '')
      } catch (error) {
        logger.child('onebot').warn('核对登录的 QQ 号失败：', error.message)
      }
      if (onebotState !== 'connected') return
      if (!uin) {
        // 核对不了就别用，断开后由看门狗重试
        onebot.stop()
        return
      }
      if (await snowluma.confirmLogin(uin)) {
        loginOk = true
        wrongAccount = ''
        // 把核对期间攒下的补上（按到达顺序）
        const queued = pendingEvents
        pendingEvents = []
        for (const ev of queued) handleEvent(ev)
      } else {
        wrongAccount = uin
        pendingEvents = []
        onebot.stop()
      }
    } finally {
      verifying = false
    }
  }

  /** 核对通过后的事件都在这里处理（onEvent 直接调，核对期间攒下的也会补到这里）。 */
  function handleEvent(ev) {
    if (!getHub()) return
    const gap = gapTracker.notePacket()
    if (gap && getConfig().backfill?.enabled !== false) {
      triggerBackfill(gap)
    }
    if (ev.post_type === 'message' && ev.message_id) {
      const key = ev.message_type === 'group' ? `group:${ev.group_id}` : `private:${ev.user_id}`
      seenIds.add(key, ev.message_id)
    }
    // 模块能看到所有原始事件（加群、撤回、好友申请……），只看不拦
    getMods()?.emit('onebot', ev)
    if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
      if (ev.post_type === 'message') {
        // 危险命令确认：主人的「确认 / 取消」回复先在这里截住，不交给聊天中枢
        const guard = getDangerGuard()
        if (guard && ev.message_type === 'private') {
          const text = Array.isArray(ev.message)
            ? ev.message.filter((seg) => seg && seg.type === 'text').map((seg) => String(seg.data?.text || '')).join('')
            : ''
          if (guard.handleReply(`private:${ev.user_id}`, ev.user_id, text)) return
        }
        dispatch(ev, 'message')
      }
    } else if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      dispatch(ev, 'poke')
    }
  }

  const onebot = createOneBotClient({
    endpoint,
    log: logger.child('onebot'),
    onState: (s, d) => {
      onebotState = s
      if (s !== 'connected') { loginOk = false; pendingEvents = [] }
      else checkLogin().catch((error) => log.warn('核对登录号出错：', error.message))
      logger.child('onebot').info(`QQ 网关：${s}${d ? '（' + d + '）' : ''}`)
      getMods()?.emit('onebot/state', s)
    },
    onEvent: (ev) => {
      // 还没核对是机器人号：核对期间先攒着，核对通过后补处理
      if (!loginOk) {
        if (verifying) {
          pendingEvents.push(ev)
          if (pendingEvents.length > 200) pendingEvents.shift()
        }
        return
      }
      handleEvent(ev)
    },
  })

  return {
    onebot,
    handleEvent,
    triggerBackfill,
    /** 面板与 /save 等写入方消费；onebotState/loginOk 只读，wrongAccount 可清。 */
    state: {
      get onebotState () { return onebotState },
      get loginOk () { return loginOk },
      get wrongAccount () { return wrongAccount },
      set wrongAccount (v) { wrongAccount = v },
      get seenIds () { return seenIds },
    },
  }
}
