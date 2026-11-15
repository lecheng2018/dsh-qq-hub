// SnowLuma 能力补齐（语义移植上游 8f58ce4）：加群申请、临时会话、闪传文件、卡片发送。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { createOutbox } from '../src/chat/outbox.js'
import { cardSegment, cardFallbackText } from '../src/modules/qq-tools/index.js'

const { default: contacts } = await import('../src/modules/contacts/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const ownerPm = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const group = { kind: 'group', userId: OWNER, groupId: '555', chatId: 'group:555' }

// ---------------- 加群申请 ----------------

function setupContacts({ cfg = {}, allOwner = true, callImpl } = {}) {
  let config = normalize({ ownerQQ: OWNER, botQQ: BOT, dryRun: false, ...cfg })
  const calls = []
  const sent = []
  const listeners = {}
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-sl-contacts-'))
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => allOwner },
      onebot: { call: async (action, params) => { calls.push({ action, params }); if (callImpl) return callImpl(action, params); return null } },
    },
    log: { warn() {}, info() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  }
  contacts.setup(api)
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((t) => [t.name, t]))
  return { calls, sent, tools, event: (ev) => listeners.onebot(ev), dir }
}
const groupEv = (over = {}) => ({ post_type: 'request', request_type: 'group', sub_type: 'add', user_id: 40004, group_id: 555, comment: '想加入', flag: 'g_abc', ...over })

test('加群申请事件：记下 flag、通知主人，同一条不重复，sub_type 过滤', () => {
  const t = setupContacts()
  t.event(groupEv())
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].chatId, `private:${OWNER}`)
  assert.match(t.sent[0].text, /40004/)
  assert.match(t.sent[0].text, /555/)
  t.event(groupEv())
  assert.equal(t.sent.length, 1, '同 flag 不重复通知')
  t.event(groupEv({ flag: 'g_inv', sub_type: 'invite', invited_id: Number(BOT) }))
  assert.equal(t.sent.length, 2)
  assert.match(t.sent[1].text, /邀请我加入/)
  t.event(groupEv({ flag: 'g_x', sub_type: 'other' }))
  assert.equal(t.sent.length, 2, '未知 sub_type 忽略')
  t.event({ post_type: 'notice' })
  assert.equal(t.sent.length, 2)
})

test('加群申请：主人批准 → set_group_add_request 原样 flag + sub_type，处理后移出列表', async () => {
  const t = setupContacts()
  t.event(groupEv())
  const tools = t.tools(ownerPm)
  const listed = await tools.qq_list_group_requests.execute({})
  assert.equal(listed.ok, true)
  assert.match(listed.message, /g_abc/)
  const r = await tools.qq_handle_group_request.execute({ approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls[0], { action: 'set_group_add_request', params: { flag: 'g_abc', sub_type: 'add', approve: true } })
  const after = await tools.qq_list_group_requests.execute({})
  assert.match(after.message, /没有待处理/)
})

test('加群申请：拒绝带 reason；多条必须指定 flag；approve 非布尔拒绝', async () => {
  const t = setupContacts()
  t.event(groupEv())
  t.event(groupEv({ flag: 'g_def', user_id: 40005 }))
  const tools = t.tools(ownerPm)
  const noFlag = await tools.qq_handle_group_request.execute({ approve: false })
  assert.equal(noFlag.ok, false)
  assert.match(noFlag.message, /指定 flag/)
  const r = await tools.qq_handle_group_request.execute({ flag: 'g_def', approve: false, reason: '人满了' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls[0].params, { flag: 'g_def', sub_type: 'add', approve: false, reason: '人满了' })
  const bad = await tools.qq_handle_group_request.execute({ approve: 'yes' })
  assert.equal(bad.ok, false)
})

test('加群申请：非主人/群聊拿不到工具；allOwner=false 执行被拒；权限 off 不通知', async () => {
  const t = setupContacts()
  assert.equal(t.tools(group).qq_handle_group_request, undefined, '群里不挂加群工具')
  assert.equal(t.tools({ kind: 'private', userId: '30003', chatId: 'private:30003' }).qq_list_group_requests, undefined)
  const t2 = setupContacts({ allOwner: false })
  t2.event(groupEv())
  const r = await t2.tools(ownerPm).qq_handle_group_request.execute({ approve: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /主人私聊/)
  assert.equal(t2.calls.length, 0)
  const t3 = setupContacts({ cfg: { profilePerms: { qqFriendRequest: 'off' } } })
  t3.event(groupEv())
  assert.equal(t3.sent.length, 0, '权限 off 不通知')
})

test('加群申请：网关失败当失败，flag 留在列表；试运行不实发', async () => {
  const t = setupContacts({ callImpl: () => { throw new Error('网关炸了') } })
  t.event(groupEv())
  const r = await t.tools(ownerPm).qq_handle_group_request.execute({ approve: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /网关炸了/)
  const listed = await t.tools(ownerPm).qq_list_group_requests.execute({})
  assert.match(listed.message, /g_abc/, '失败后 flag 仍在')
  const t2 = setupContacts({ cfg: { dryRun: true } })
  t2.event(groupEv())
  const dry = await t2.tools(ownerPm).qq_handle_group_request.execute({ approve: true })
  assert.equal(dry.ok, true)
  assert.match(dry.message, /试运行/)
  assert.equal(t2.calls.length, 0)
})

// ---------------- 临时会话 ----------------

const tempEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'group',
  user_id: 30003, self_id: Number(BOT), message_id: 1,
  sender: { user_id: 30003, nickname: '路人', group_id: 555 },
  message: [{ type: 'text', data: { text: '你好' } }],
  ...over,
})

test('parseMessageEvent：临时会话识别 sourceGroupId，非法值不认', () => {
  assert.equal(parseMessageEvent(tempEv(), BOT).sourceGroupId, '555')
  assert.equal(parseMessageEvent(tempEv({ sub_type: 'friend' }), BOT).sourceGroupId, '')
  assert.equal(parseMessageEvent(tempEv({ sender: { group_id: 0 } }), BOT).sourceGroupId, '')
  assert.equal(parseMessageEvent(tempEv({ sender: { group_id: 'abc' } }), BOT).sourceGroupId, '')
  assert.equal(parseMessageEvent({ ...tempEv(), message_type: 'group', group_id: 555 }, BOT).sourceGroupId, '', '群消息不带')
})

test('outbox：登记来源群后私聊回复带 group_id；普通私聊不带', async () => {
  const calls = []
  const send = async (action, params) => { calls.push({ action, params }); return { messageId: 'm1' } }
  const outbox = createOutbox({ send, dryRun: () => false, enabled: () => true })
  outbox.notePrivateSource('30003', '555')
  const r1 = await outbox.request({ chatKey: 'private:30003', segments: [{ type: 'text', data: { text: '回临时会话' } }] })
  assert.equal(r1.state, 'sent')
  assert.equal(calls[0].action, 'send_private_msg')
  assert.equal(calls[0].params.group_id, 555)
  assert.equal(calls[0].params.user_id, 30003)
  const r2 = await outbox.request({ chatKey: 'private:10001', segments: [{ type: 'text', data: { text: '普通私聊' } }] })
  assert.equal(r2.state, 'sent')
  assert.equal(calls[1].params.group_id, undefined, '没登记过的私聊不带 group_id')
  outbox.notePrivateSource('30003', 'not-a-number')
  await outbox.request({ chatKey: 'private:30003', segments: [{ type: 'text', data: { text: 'x' } }] })
  assert.equal(calls[2].params.group_id, 555, '非法来源不覆盖（last-source-wins）')
  outbox.dispose()
})

// ---------------- 闪传文件 ----------------

test('flash_file 段解析为文本占位', () => {
  const ev = { ...tempEv(), sub_type: 'friend', message: [{ type: 'flash_file', data: { title: '照片.zip' } }] }
  assert.match(parseMessageEvent(ev, BOT).text, /\[闪传文件：照片\.zip\]/)
  const ev2 = { ...ev, message: [{ type: 'flash_file', data: {} }] }
  assert.match(parseMessageEvent(ev2, BOT).text, /\[闪传文件\]/)
})

// ---------------- 卡片 ----------------

test('cardSegment：share/music/location/contact/dice/rps 校验', () => {
  assert.deepEqual(cardSegment({ type: 'share', url: 'https://x.com', title: '标题' }).segment, { type: 'share', data: { url: 'https://x.com', title: '标题' } })
  assert.match(cardSegment({ type: 'share', url: 'file:///etc/passwd', title: 'x' }).error, /http/)
  assert.match(cardSegment({ type: 'share', url: 'https://x.com' }).error, /缺参数/)
  assert.match(cardSegment({ type: 'nope' }).error, /type/)
  const music = cardSegment({ type: 'music', music_type: 'custom', url: 'https://x.com/s', audio: 'https://x.com/a', title: '歌' })
  assert.equal(music.segment.data.type, 'custom')
  assert.equal(music.segment.data.audio, 'https://x.com/a')
  assert.match(cardSegment({ type: 'music', music_type: 'qq' }).error, /缺参数/, '平台音乐要 id')
  assert.deepEqual(cardSegment({ type: 'music', music_type: 'qq', id: '123' }).segment.data, { type: 'qq', id: '123' })
  assert.equal(cardSegment({ type: 'location', lat: 30.1, lon: 120.2, title: '家' }).segment.data.lat, '30.1')
  assert.match(cardSegment({ type: 'location', lat: 91, lon: 0 }).error, /超出范围/)
  assert.equal(cardSegment({ type: 'contact', contact_type: 'qq', id: '10001' }).segment.data.type, 'qq')
  assert.match(cardSegment({ type: 'contact', contact_type: 'wx', id: '10001' }).error, /qq 或 group/)
  assert.deepEqual(cardSegment({ type: 'dice' }).segment, { type: 'dice', data: {} })
  assert.deepEqual(cardSegment({ type: 'rps' }).segment, { type: 'rps', data: {} })
  assert.match(cardFallbackText({ type: 'share', data: { title: '标题', url: 'https://x.com' } }), /\[卡片：share 标题 https:\/\/x\.com\]/)
})

test('qq_send_card：成功走 sendSegments；网关不支持降级文本摘要', async () => {
  const { default: qqTools } = await import('../src/modules/qq-tools/index.js')
  function setupTools({ sendSegmentsImpl, deliverImpl } = {}) {
    const sent = []
    let builder
    const api = {
      core: {
        hub: {
          sendSegments: sendSegmentsImpl || (async (chatId, segs, note) => { sent.push({ chatId, segs, note }); return { messageId: 'm1' } }),
          deliver: deliverImpl || (async (chatId, text) => { sent.push({ chatId, text }); return {} }),
        },
        onebot: { call: async () => null },
      },
      config: () => normalize({ ownerQQ: OWNER, botQQ: BOT, files: { enabled: true } }),
      tool: (b) => { builder = b },
      log: { warn() {}, info() {} },
    }
    qqTools.setup(api)
    return { sent, tools: (chat, level) => Object.fromEntries(builder({ chat, level }).map((t) => [t.name, t])) }
  }
  const ok = setupTools()
  const r = await ok.tools(ownerPm, 'full').qq_send_card.execute({ type: 'share', url: 'https://x.com', title: '分享' })
  assert.equal(r.ok, true)
  assert.equal(ok.sent[0].segs[0].type, 'share')
  assert.equal(ok.tools(ownerPm, 'basic').qq_send_card, undefined, '非 full 不挂')

  const degraded = setupTools({ sendSegmentsImpl: async () => { throw new Error('unsupported segment') } })
  const r2 = await degraded.tools(ownerPm, 'full').qq_send_card.execute({ type: 'share', url: 'https://x.com', title: '分享' })
  assert.equal(r2.ok, true, '降级不算失败')
  assert.match(r2.message, /文字摘要/)
  assert.match(degraded.sent[0].text, /\[卡片：share/)

  const bad = setupTools({
    sendSegmentsImpl: async () => { throw new Error('unsupported') },
    deliverImpl: async () => { throw new Error('全挂了') },
  })
  const r3 = await bad.tools(ownerPm, 'full').qq_send_card.execute({ type: 'dice' })
  assert.equal(r3.ok, false)
  const invalid = await ok.tools(ownerPm, 'full').qq_send_card.execute({ type: 'share' })
  assert.equal(invalid.ok, false)
})
