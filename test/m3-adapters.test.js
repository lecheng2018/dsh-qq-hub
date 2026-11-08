// M3-A/B/C/D 适配器契约测试（fake DSH / fake OneBot，全链不接生产主链）

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { legacyEventToNormalized, legacyInboundBatch } from '../src/chat/adapters/legacy-inbound.js'
import { createDshSessionAdapter } from '../src/chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter, paramsFor } from '../src/chat/adapters/onebot-outbox.js'
import { createLegacyContextAdapter } from '../src/chat/adapters/legacy-context.js'
import { createSessionRegistry } from '../src/chat/session-registry.js'
import { createOutbox } from '../src/chat/outbox.js'

const SELF = '20000002'
const baseEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(SELF), user_id: 10001, message_id: 42, time: 1_763_000_000,
  sender: { user_id: 10001, nickname: '主人', card: '老板' },
  message: [{ type: 'text', data: { text: '你好呀' } }],
  ...over,
})

// ---------- M3-A legacy inbound ----------

test('M3-A：私聊/群聊/引用/@/图片/语音/文件/转发 全形态映射（与 parseMessageEvent 同源）', () => {
  const priv = legacyEventToNormalized(baseEv(), { selfId: SELF })
  assert.equal(priv.chatKey, 'private:10001')
  assert.equal(priv.messageId, '42')
  assert.equal(priv.sender.userId, '10001')
  assert.equal(priv.sender.nickname, '老板', '群卡片优先（card > nickname 同 legacy）')

  const grp = legacyEventToNormalized(baseEv({
    message_type: 'group', group_id: 777,
    message: [
      { type: 'reply', data: { id: '999' } },
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 看这个 ' } },
      { type: 'image', data: { url: 'https://x/p.png' } },
      { type: 'record', data: { file: 'https://x/a.mp3' } },
      { type: 'file', data: { file_id: 'f1', file_name: 'doc.pdf' } },
      { type: 'forward', data: { id: 'fw1' } },
    ],
  }), { selfId: SELF })
  assert.equal(grp.chatKey, 'group:777')
  const types = grp.segments.map((s) => s.type)
  for (const t of ['reply', 'at', 'text', 'image', 'record', 'file', 'forward']) {
    assert.ok(types.includes(t), `段类型 ${t} 保留`)
  }
})

test('M3-A：CQ 码字符串消息、message_sent 自发事件、backfill 来源', () => {
  const cq = legacyEventToNormalized(baseEv({ message: '纯文字 [CQ:face,id=1] 尾巴' }), { selfId: SELF })
  assert.equal(cq.segments.length, 1)
  assert.equal(cq.segments[0].type, 'text')

  const sent = legacyEventToNormalized(baseEv({ post_type: 'message_sent', user_id: Number(SELF) }), { selfId: SELF })
  assert.equal(sent.sender.userId, SELF, '自发事件 sender=机器人号')
  assert.equal(sent.source, 'realtime')

  const backfill = legacyEventToNormalized(baseEv(), { selfId: SELF, source: 'backfill', timestamp: 1_762_000_000_000 })
  assert.equal(backfill.source, 'backfill')
  assert.equal(backfill.timestamp, 1_762_000_000_000, '补收保留原始时间')
})

test('M3-A：poke 事件、缺键事件 fail-closed（不猜键）、非法 post_type 拒绝', () => {
  const poke = legacyEventToNormalized({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 777, user_id: 555, target_id: Number(SELF), time: 1_763_000_000,
  }, { selfId: SELF })
  assert.equal(poke.chatKey, 'group:777')
  assert.equal(poke.segments[0].type, 'poke')
  assert.equal(poke.segments[0].data.targetId, SELF)

  assert.throws(() => legacyEventToNormalized({ post_type: 'message', message: [] }, { selfId: SELF }), /无法成键/)
  assert.throws(() => legacyEventToNormalized({ post_type: 'request' }, { selfId: SELF }), /只处理/)
  assert.throws(() => legacyEventToNormalized(null), TypeError)
})

test('M3-A：批量适配——无主事件跳过留痕，好事件正常产出（含富视图）', () => {
  const batch = legacyInboundBatch([
    baseEv({ message_id: 1 }),
    { post_type: 'message', message: [] }, // 缺键
    baseEv({ message_id: 2, message_type: 'group', group_id: 888 }),
  ], { selfId: SELF })
  assert.equal(batch.length, 3)
  assert.equal(batch[0].inbound.messageId, '1')
  assert.equal(batch[1].inbound, null, '无主事件跳过')
  assert.ok(batch[1].event, '留痕原始事件')
  assert.equal(batch[2].view.chatId, 'group:888', '富视图与 inbound 同出')
  assert.equal(batch[2].view.mentioned, false)
})

// ---------- M3-B DSH session adapter ----------

test('M3-B：DSH 适配器 + SessionRegistry 全链（fake sessionController）', async () => {
  const created = []
  const fakeDsh = {
    services: {
      sessionController: {
        async create({ workspaceId, agentPreset }) {
          const id = `sess-${created.length + 1}`
          created.push({ workspaceId, agentPreset })
          return { sessionId: id, agentPreset }
        },
        async resolveAgent(id) {
          return created.some((c) => false) ? { agent: {} } : { error: { code: 'session/not-found' } }
        },
      },
    },
    // 真机 cordis 契约：sessionController 走 ctx.get 拿（缺陷 3——不能直接点 .services）
    get(name) { return this.services?.[name] ?? null },
  }
  const adapter = createDshSessionAdapter({
    dsh: fakeDsh,
    presetOf: (chatKey) => (chatKey.startsWith('group:')
      ? { agentPreset: 'qq-hub-social' }
      : { agentPreset: 'qq-hub-private', workspaceId: 'ws-1' }),
  })
  const reg = createSessionRegistry({ createSession: adapter.createSession })
  const p = await reg.sessionFor('private:10001')
  const g = await reg.sessionFor('group:777')
  assert.equal(p.sessionId, 'sess-1')
  assert.equal(g.sessionId, 'sess-2')
  assert.deepEqual(created[0], { workspaceId: 'ws-1', agentPreset: 'qq-hub-private' }, '私聊 preset/workspace 透传')
  assert.deepEqual(created[1], { workspaceId: undefined, agentPreset: 'qq-hub-social' }, '群聊走 social 预设')
  // 回读校验
  const resolved = await adapter.resolveAgent(p.sessionId)
  assert.equal(resolved.ok, false, 'fake 控制器没记录该会话时如实报 not-found（不谎报存在）')
  await reg.dispose()
})

test('M3-B：迁移器——旧映射导入、回读校验、损坏记录失败关闭、幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3b-'))
  try {
    const legacyFile = join(dir, 'legacy.json')
    writeFileSync(legacyFile, JSON.stringify({ chats: { 'group:777': { sessionId: 'old-g' }, '10001': { sessionId: 'old-p' }, 'bad!': { sessionId: 'x' } } }))
    const { createSessionFileStore, migrateLegacySessions } = await import('../src/chat/session-store.js')
    const store = createSessionFileStore({ file: join(dir, 'sessions.json') })
    const r1 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r1.imported, 2)
    assert.equal(r1.skipped.length, 1)
    // 回读校验：导入的键能读回且 ChatKey 合法
    const loaded = store.load()
    assert.equal(loaded['group:777'].sessionId, 'old-g')
    assert.equal(loaded['private:10001'].sessionId, 'old-p')
    // 幂等
    const r2 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r2.imported, 2)
    assert.equal(Object.keys(store.load()).length, 2)
    // 损坏旧文件：报告错误不崩
    writeFileSync(legacyFile, '{bad')
    const r3 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r3.errors.length, 1)
    assert.equal(r3.imported, 0)
    // 数据不丢（第二次迁移结果仍在）
    assert.equal(Object.keys(store.load()).length, 2)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

// ---------- M3-C OneBot outbox adapter ----------

test('M3-C：outbox 适配器全链——真实回执入账、明确拒绝=failed、超时=unknown、无回执=unknown', async () => {
  const calls = []
  const onebot = {
    call: async (action, params) => {
      calls.push({ action, params })
      if (params.user_id === 1) return { message_id: 7001 }
      if (params.user_id === 2) { const e = new Error('x'); e.unknown = false; throw e }
      if (params.user_id === 3) { const e = new Error('超时'); e.unknown = true; throw e }
      if (params.user_id === 4) return {}
      throw new Error('不该到这')
    },
  }
  const outbox = createOutbox({ send: createOnebotOutboxAdapter({ onebot }).send })
  const ok = await outbox.request({ chatKey: 'private:1', segments: [{ type: 'text', data: { text: 'a' } }] })
  assert.equal(ok.state, 'sent')
  assert.equal(ok.gatewayMessageId, '7001', '真实网关 messageId 入账')

  const failed = await outbox.request({ chatKey: 'private:2', segments: [{ type: 'text', data: { text: 'b' } }] })
  assert.equal(failed.state, 'failed')
  const unknown = await outbox.request({ chatKey: 'private:3', segments: [{ type: 'text', data: { text: 'c' } }] })
  assert.equal(unknown.state, 'unknown', 'unknown 不自动重发不伪造')
  const noReceipt = await outbox.request({ chatKey: 'private:4', segments: [{ type: 'text', data: { text: 'd' } }] })
  assert.equal(noReceipt.state, 'unknown', '回执丢失如实 unknown')
  assert.equal(calls.length, 4, '全程恰好 4 次真实调用（无重试）')
  // 台账对账
  assert.equal(outbox.ledger.get(ok.deliveryId).gatewayMessageId, '7001')
})

test('M3-C：paramsFor 形状（群/私聊）与非法 ChatKey', async () => {
  assert.deepEqual(paramsFor('group:777', []), { group_id: 777, message: [] })
  assert.deepEqual(paramsFor('private:55', []), { user_id: 55, message: [] })
  assert.throws(() => paramsFor('10001', []), TypeError)
  // 非消息动作直接拒绝（物理出口只发消息）
  const adapter = createOnebotOutboxAdapter({ onebot: { call: async () => ({}) } })
  await assert.rejects(() => adapter.send('set_group_ban', {}), /只发消息/)
})

// ---------- M3-D legacy context adapter ----------

test('M3-D：contextFor 映射为 provider——scope/sessionId 传递、异常隔离、空值不产碎片', async () => {
  const calls = []
  const adapter = createLegacyContextAdapter({
    mods: {
      contextFor: async (args) => {
        calls.push(args)
        // 真机审计 1.1 第二层：legacy provider 契约吃 { chat, sessionId }（provider 解构 chat.kind）。
        // 此前适配器传 { chatId } → chat=undefined → provider 抛错被吞 → 全员空串。
        if (args.chat && args.chat.kind === 'group' && args.chat.groupId === '777') return '群聊记忆'
        if (args.chatId === 'private:9999' || (args.chat && args.chat.kind === 'private' && args.chat.userId === '9999')) throw new Error('模块炸了')
        return ''
      },
    },
    priority: 90,
  })
  assert.equal(adapter.moduleId, 'legacy-context')
  assert.equal(adapter.onError, 'isolate')
  const { createContextAssembly } = await import('../src/chat/context-assembly.js')
  const assembly = createContextAssembly({ providers: [adapter] })
  const g = await assembly.assemble({ chatKey: 'group:777', sessionId: 'sess-1' })
  assert.equal(g.fragments[0].content, '群聊记忆')
  assert.equal(g.fragments[0].scope, 'global', 'legacy adapter 声明 global（内部分发）')
  assert.equal(g.fragments[0].sessionId, 'sess-1', '真实 sessionId 透传')
  assert.deepEqual(calls[0], { chat: { kind: 'group', chatId: 'group:777', groupId: '777', userId: '' }, sessionId: 'sess-1' }, 'legacy 签名 { chat, sessionId }（chat 从 ChatKey 如实派生）')
  // 模块炸：isolate——记录错误不阻断
  const b = await assembly.assemble({ chatKey: 'private:9999', sessionId: 's' })
  assert.equal(b.fragments.length, 0)
  assert.equal(b.errors[0].moduleId, 'legacy-context')
  // 空上下文：不产碎片
  const e = await assembly.assemble({ chatKey: 'private:55', sessionId: 's' })
  assert.equal(e.fragments.length, 0)
})
