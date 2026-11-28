// Batch 3 · T3.4：DSH 0.2.3-alpha.2 的 `session.header.agentPreset` 兼容
//
// 改前只读 `agent.session.agentPreset` / `session.agentPreset` / `agentPreset`：
// 升级到 0.2.3-alpha.2 后 preset 被挪进 `session.header`，取到的永远是空串 →
//   ① 所有 QQ Hub 会话被判成「别人的网页会话」（hub.chatOfSession 未命中时），
//      危险命令确认闸整条漏放；
//   ② 分群人设映射（qq-hub-group / qq-hub-private）全部失效。
// 这里直接导入 host.js 的真实取值函数与判定构造器，并让真实 dangerGuard 走一遍。

import test from 'node:test'
import assert from 'node:assert/strict'

import { agentPresetOf, makeIsQqSession } from '../src/host.js'
import { createDangerGuard } from '../src/security/danger.js'

const OWNER_QQ = '10000001'

test('T3.4 agentPresetOf：优先读 session.header.agentPreset（0.2.3-alpha.2 新位置）', () => {
  // 新版布局：agent.session.header
  assert.equal(agentPresetOf({ agent: { session: { header: { agentPreset: 'qq-hub-private' } } } }), 'qq-hub-private')
  // 新版布局：裸 session.header
  assert.equal(agentPresetOf({ session: { header: { agentPreset: 'qq-hub-group' } } }), 'qq-hub-group')
  // 老布局继续兼容
  assert.equal(agentPresetOf({ agent: { session: { agentPreset: 'qq-hub-private' } } }), 'qq-hub-private')
  assert.equal(agentPresetOf({ session: { agentPreset: 'qq-hub-group' } }), 'qq-hub-group')
  assert.equal(agentPresetOf({ agentPreset: 'standard' }), 'standard')
  // 都没有 → 空串（不是 'undefined'）
  assert.equal(agentPresetOf({}), '')
  assert.equal(agentPresetOf(null), '')
})

test('T3.4 makeIsQqSession：只有 session.header.agentPreset 也能认出 QQ 会话', () => {
  const isQqSession = makeIsQqSession({
    chatOfSession: () => '', // hub 还没建好映射（启动早期就是这个状态）
    isSystemSession: () => false,
  })
  assert.equal(isQqSession('sess-1', { agent: { session: { header: { agentPreset: 'qq-hub-private' } } } }), true)
  assert.equal(isQqSession('sess-2', { session: { header: { agentPreset: 'qq-hub-group' } } }), true)
  // 网页会话（standard）不能被误认成 QQ 会话
  assert.equal(isQqSession('sess-3', { agent: { session: { header: { agentPreset: 'standard' } } } }), false)
  // 老字段仍然有效
  assert.equal(isQqSession('sess-4', { agent: { session: { agentPreset: 'qq-hub-private' } } }), true)
  // 有映射（chatOfSession 命中）就算 QQ 会话
  assert.equal(makeIsQqSession({ chatOfSession: () => 'private:10000001' })('sess-5', {}), true)
  // 映射查询抛错不许炸（宿主没就绪时）
  assert.equal(makeIsQqSession({ chatOfSession: () => { throw new Error('boom') } })('sess-6', { agentPreset: 'standard' }), false)
})

test('T3.4 危险命令闸：0.2.3-alpha.2 布局下的 QQ 会话必须真的被拦（不是直接放行）', async () => {
  const delivered = []
  const guard = createDangerGuard({
    getConfig: () => ({ security: { dangerConfirm: true } }),
    deliver: async (chatId, text) => { delivered.push({ chatId, text }); return { message_id: 1 } },
    chatOfSession: () => '',
    isQqSession: makeIsQqSession({ chatOfSession: () => '', isSystemSession: () => false }),
    ownerQQ: () => OWNER_QQ,
  })
  const exec = {
    name: 'bash',
    arguments: { command: 'rm -rf /' },
    agent: { session: { id: 'sess-qq', header: { agentPreset: 'qq-hub-private' } } },
  }
  const blocked = await guard.preExecute(exec, () => assert.fail('QQ 会话的危险命令不许直接放行'))
  assert.equal(blocked.kind, 'deny')
  assert.equal(delivered.length, 0, '未映射到 QQ 聊天时按 deny 处理，不发确认')

  // 对照：普通网页会话（standard）仍然直接放行，不误杀
  const webExec = { name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 'sess-web', header: { agentPreset: 'standard' } } } }
  assert.equal(await guard.preExecute(webExec, () => 'NEXT'), 'NEXT')
})
