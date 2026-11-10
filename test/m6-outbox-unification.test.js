// PR-1（ADR-0002）验收：Outbox 收口——hub/模块/直调发送全部转进唯一出口。
// 断言四件事：
//   1) 直通模式（action+params）：台账有记录、receipt 策略正确（upload 无 message_id 也算 sent；
//      msg 无回执仍 unknown 红线不破）；
//   2) 全局闸对直通同样生效：dryRun/enabled cancelled、身份闸扫直通 params（string message / content）；
//   3) egress 语义映射：sent→raw 原样、cancelled→null、unknown→error.unknown=true、failed→error.unknown=false；
//   4) 无第二写者（源码面）：qzone/multi-parser/modules 的 send|upload 动作全部经 deliverRaw 分流。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createOutbox, newDeliveryId } from '../src/chat/outbox.js'
import { createHubEgress } from '../src/host/hub-egress.js'
import { createSharedOutbox } from '../src/host/shared-outbox.js'
import { checkIdentityLeak } from '../src/chat/identity-guard.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

function coreEgress({ sent = [], dryRun = false, enabled = true, cfg = { ownerQQ: '10000001', botQQ: '20000002', allow: { private: ['10000001'], groups: ['777'] }, security: { identityGuard: { enabled: true, mode: 'block' } } } } = {}) {
  const calls = []
  const outbox = createOutbox({
    send: async (action, params) => {
      calls.push({ action, params })
      if (action === 'upload_group_file') { sent.push(action); return { messageId: undefined, raw: { file_id: 'f-1' } } }
      if (action === 'send_poke') { sent.push(action); return { raw: null } }
      if (action === 'send_qzone_msg') { sent.push(action); return { raw: { tid: 't-9' } } }
      if (action === 'send_group_forward_msg' || action === 'send_private_forward_msg') { sent.push(action); return { messageId: '7770', raw: { message_id: 7770 } } }
      sent.push(action)
      return { messageId: '9001', raw: { message_id: 9001 } }
    },
    authorize: async (d) => {
      const key = String(d.chatKey)
      if (key.startsWith('group:')) return (cfg.allow.groups || []).map(String).includes(key.slice(6))
      return (cfg.allow.private || []).map(String).includes(key.slice(8)) || key.slice(8) === String(cfg.ownerQQ)
    },
    enabled: () => enabled,
    dryRun: () => dryRun,
    guard: (d) => {
      const ig = cfg.security?.identityGuard || {}
      if (ig.enabled === false) return { ok: true }
      const p = d.params || {}
      const extra = [typeof p.message === 'string' ? p.message : '', p.name, p.content].filter(Boolean).join(' ')
      const text = (Array.isArray(d.segments) ? d.segments : []).filter((s) => s?.type === 'text').map((s) => String(s?.data?.text || '')).join('') || extra
      const ownGroup = String(d.chatKey || '').startsWith('group:') ? String(d.chatKey).slice(6) : ''
      return checkIdentityLeak(text, {
        surface: '消息', ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(String(d.chatKey || '').startsWith('private:') ? [cfg.ownerQQ] : [])].filter(Boolean),
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
    },
  })
  return { outbox, calls, sent, egress: createHubEgress({ outbox, log: noopLog }) }
}

test('PR-1 直通：upload/poke/qzone 无 message_id 也如实 sent（receipt optional），台账全量可读', async () => {
  const { egress, outbox, calls } = coreEgress()
  const r1 = await egress.deliver({ action: 'upload_group_file', params: { group_id: 777, file: 'x.txt', name: 'x.txt' }, chatKey: 'group:777', receipt: 'optional', note: '[文件] x.txt', sourceModuleId: 'hub' })
  assert.deepEqual(r1, { file_id: 'f-1' }, 'sent 返回网关 raw（legacy 形状）')
  const r2 = await egress.deliver({ action: 'send_poke', params: { user_id: 10000001 }, chatKey: 'private:10000001', receipt: 'optional', note: '戳一戳', sourceModuleId: 'hub' })
  assert.equal(r2.raw === undefined || typeof r2 === 'object', true)
  assert.equal(calls.length, 2)
  const stats = outbox.ledger.stats()
  assert.equal(stats.byState.sent, 2, '两笔都入台账 sent')
})

test('PR-1 直通：msg 动作无回执仍判 unknown（红线不破）', async () => {
  const outbox = createOutbox({ send: async () => ({ raw: {} }), }) // 无 messageId
  const r = await outbox.request({ chatKey: 'private:10000001', action: 'send_private_msg', params: { user_id: 1, message: 'hi' }, receipt: 'required' })
  assert.equal(r.state, 'unknown')
})

test('PR-1 全局闸对直通生效：dryRun→cancelled(null)、enabled=false→cancelled、泄露闸扫 params.content/name', async () => {
  const a = coreEgress({ dryRun: true })
  assert.equal(await a.egress.deliver({ action: 'send_qzone_msg', params: { content: '随便' }, chatKey: 'private:20000002', receipt: 'optional' }), null, 'dryRun：deliver 返回 null=legacy 没发语义')
  assert.ok((a.outbox.ledger.stats().byState.cancelled ?? 0) >= 1, 'dryRun 也记台账（矩阵：全部出口可审计）')

  const b = coreEgress({ enabled: false })
  assert.equal(await b.egress.deliver({ action: 'send_poke', params: { user_id: 1 }, chatKey: 'private:10000001', receipt: 'optional' }), null)

  const c = coreEgress()
  const leak = await c.egress.deliver({ action: 'send_qzone_msg', params: { content: '主人号 10000002 别告诉别人', ugc_right: '6' }, chatKey: 'private:20000002', receipt: 'optional' }).catch((e) => e)
  assert.ok(c.sent.length === 0, '泄露闸拦住说说正文外发')
  assert.ok((c.outbox.ledger.stats().byState.cancelled ?? 0) >= 1)
  void leak
})

test('PR-1 egress 错误语义：unknown→error.unknown=true，failed→error.unknown=false（legacy 重试判据兼容）', async () => {
  const outbox = createOutbox({
    send: async (action) => { if (action === 'send_boom') { const e = new Error('超时'); e.unknown = true; throw e } if (action === 'send_no') { const e = new Error('拒绝'); e.unknown = false; throw e } return { raw: {} } },
  })
  const eg = createHubEgress({ outbox, log: noopLog })
  await assert.rejects(() => eg.deliver({ action: 'send_boom', params: { user_id: 1 }, chatKey: 'private:10000001', receipt: 'optional' }), (e) => e.unknown === true)
  await assert.rejects(() => eg.deliver({ action: 'send_no', params: { user_id: 1 }, chatKey: 'private:10000001', receipt: 'optional' }), (e) => e.unknown === false)
})

test('PR-1 白名单复核对直通生效：非白名单群 upload 拒绝（authorize 按 chatKey）', async () => {
  const { egress, sent } = coreEgress()
  const r = await egress.deliver({ action: 'upload_group_file', params: { group_id: 999, file: 'a', name: 'a' }, chatKey: 'group:999', receipt: 'optional' })
  assert.equal(r, null)
  assert.equal(sent.length, 0)
})

test('PR-1 安全网：管理/删除类动作误入 egress → 拒绝执行（fail-closed，防 receipt optional 洗白 set_/delete_）', async () => {
  const { egress, sent } = coreEgress()
  await assert.rejects(
    () => egress.deliver({ action: 'delete_msg', params: { message_id: 1 }, chatKey: 'private:10000001', receipt: 'optional' }),
    /egress/,
    '非发信动作必须拒',
  )
  assert.equal(sent.length, 0, '被拒动作零物理调用')
})

test('PR-1 源码面：send|upload 动作已无绕过 hub.deliverRaw 的写者（qzone/multi-parser/modules 集中分流）', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const mods = read('../src/core/modules.js')
  assert.match(mods, /\/\^\(send\|upload\)_/, 'api.onebot 发信动作集中分流到 deliverRaw')
  const qz = read('../src/features/qzone.js')
  assert.match(qz, /hub\?\.deliverRaw/, 'qzone 说说经 deliverRaw')
  const hub = read('../src/chat/hub.js')
  assert.match(hub, /deliverRaw: \(args/, 'hub 提供统一投递面 deliverRaw')
  assert.match(hub, /egressRef\?\.current/, 'hub 物理出口读 egress 插槽')
  const host = read('../src/host.js')
  assert.match(host, /egressRef\.current = createHubEgress/, 'host 开旗接线')
  assert.doesNotMatch(host, /useModularCore\s*&&\s*!usePipeline/, 'pipeline 与共享 Outbox 不再互斥，物理发送仍只有一处')
  // multi-parser 走 api.onebot('send_*forward…'/'upload_…')——由 modules.js 集中规则覆盖，无需逐处改
  const mp = read('../src/modules/multi-parser/delivery.js')
  assert.match(mp, /api\.onebot\('send_group_forward_msg'/, '转发保持 api.onebot 调用=经集中分流')
})


test('Shared Outbox 身份闸与 legacy 同口径：私聊裸数字放行、群聊拦截且写 warn', async () => {
  const calls = []
  const warnings = []
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '10000001', botQQ: '20000002',
    allow: { private: ['10000001'], groups: ['777'] },
    security: { identityGuard: { enabled: true, mode: 'block' } },
  }
  const log = { info() {}, debug() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) }
  const outbox = createSharedOutbox({
    onebot: { call: async (action, params) => { calls.push({ action, params }); return { message_id: calls.length } } },
    getConfig: () => cfg, log,
  })
  const text = '调研记录：文档 1042525600，端口 19881234。'
  const privateResult = await outbox.request({ chatKey: 'private:10000001', segments: [{ type: 'text', data: { text } }] })
  assert.equal(privateResult.state, 'sent', `私聊长文不应被裸数字误拦：${privateResult.reason || ''}`)
  assert.equal(calls.length, 1)

  const groupResult = await outbox.request({ chatKey: 'group:777', segments: [{ type: 'text', data: { text } }] })
  assert.equal(groupResult.state, 'cancelled')
  assert.equal(calls.length, 1, '群聊裸数字不能放行')
  assert.ok(warnings.some((line) => line.includes('身份泄露闸') && line.includes('group:777')), `拦截必须写日志：${JSON.stringify(warnings)}`)
})
