// PR-1（ADR-0002）· Shared Outbox：全仓唯一的物理发送出口。
//
// 架构定位：副作用统一先于主链切换——本文件把「统一出站」从模块化新核心里剥离出来，
// 成为 legacy 与新核心**共享**的基础设施（唯一实现，双方都只是调用方）：
//   - hub 的 sendText/sendSegments/sendFile/poke 经 hub-egress 转进来；
//   - 模块 api.onebot 的发信动作、qzone 说说、multi-parser 转发送经 hub.deliverRaw 转进来；
//   - 当前核心的回复同样走这里（同一台账、同一闸）。
// 装配：生产唯一物理发送出口，不提供旧核心回退。
//
// 闸与红线（与 legacy hub/reply/access 同一份实现，不另起口径）：
//   - ACL 出站复核（checkAllowed）：撤权在排队期间也能拦；
//   - enabled/dryRun 出队时动态读（面板随时可改）；
//   - 身份泄露闸（checkIdentityLeak，同 legacy sendSegments 语义，force 豁免）；
//   - 台账 fail-closed + 崩溃恢复（sending→unknown 绝不重发）。

import { createOutbox } from '../chat/outbox.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { createOnebotOutboxAdapter } from '../chat/adapters/onebot-outbox.js'
import { createGroupQuota } from '../chat/group-quota.js'
import { checkAllowed } from '../chat/access.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'

/** ChatKey → checkAllowed 的 msg 形状（私聊取号，群聊取群号）。 */
function msgFromChatKey(chatKey) {
  const key = String(chatKey || '')
  if (key.startsWith('group:')) return { kind: 'group', groupId: key.slice(6), userId: '' }
  return { kind: 'private', userId: key.slice(8), groupId: '' }
}

function textForGuard(delivery) {
  const segs = Array.isArray(delivery.segments) ? delivery.segments : []
  const fromSegments = segs.filter((s) => s && s.type === 'text').map((s) => String(s?.data?.text || '')).join('')
  const p = delivery.params || {}
  const extra = [typeof p.message === 'string' ? p.message : '', p.name, p.content].filter(Boolean).join(' ')
  return fromSegments || extra
}

/**
 * @param {object} o
 * @param {{ call: Function }} o.onebot OneBot 客户端
 * @param {() => object} o.getConfig
 * @param {object} o.log
 * @param {string} [o.ledgerFile] 台账文件（缺省内存，测试用）
 */
export function createSharedOutbox({ onebot, getConfig, log, ledgerFile, currentTicket, sleep, now }) {
  const ledger = ledgerFile ? createDeliveryLedger({ file: ledgerFile, onError: (e) => log.warn('投递台账落盘异常：', e.message) }) : undefined
  // 群发送配额（US-020）：QQ 群每分钟硬上限，超了网关直接拒、消息真丢。
  // 只在群动作上生效；私聊/戳一戳/上传等一律直通，不引入额外等待。
  // sleep / now 仅用于测试注入虚拟时钟；生产不传，走真实定时器。
  const quota = createGroupQuota({
    getConfig,
    log: log?.child ? log.child('group-quota') : log,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  })
  const sendOnce = createOnebotOutboxAdapter({ onebot }).send
  const send = async (action, params, opts) => {
    if (action !== 'send_group_msg') return sendOnce(action, params, opts)
    const groupId = String(params?.group_id ?? '')
    const r = await quota.send(groupId, () => sendOnce(action, params, opts))
    if (r.ok) return r.result
    throw r.error
  }
  return createOutbox({
    send,
    ...(ledger ? { ledger } : {}),
    authorize: async (delivery) => {
      if (delivery.action === 'send_qzone_msg') return true
      const cfg = getConfig()
      return checkAllowed(cfg, msgFromChatKey(delivery.chatKey)).allowed
    },
    // truthy 语义与 legacy 一致（cfg.enabled 缺省按关处理？不——loadConfig 恒有默认值；保持 Boolean）
    enabled: () => Boolean(getConfig().enabled),
    dryRun: () => Boolean(getConfig().dryRun),
    // 轮内（deliver 期间）的请求自动并入本轮链尾；不传就在轮内挂到本轮闸上 → 自锁
    ...(currentTicket ? { currentTicket } : {}),
    guard: (delivery) => {
      const cfg = getConfig()
      const ig = cfg.security?.identityGuard || {}
      if (ig.enabled === false) return { ok: true }
      const text = textForGuard(delivery)
      const chatKey = String(delivery.chatKey || '')
      const ownGroup = chatKey.startsWith('group:') ? chatKey.slice(6) : ''
      const result = checkIdentityLeak(text, {
        surface: chatKey.startsWith('group:') ? '群消息' : '私聊消息',
        ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(chatKey.startsWith('private:') ? [cfg.ownerQQ] : [])].filter(Boolean),
        allowBareNumbers: !chatKey.startsWith('group:'),
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
      if (!result.ok) log?.warn?.(`身份泄露闸拦下 → ${chatKey}：${result.message || ''}`)
      return result
    },
  })
}
