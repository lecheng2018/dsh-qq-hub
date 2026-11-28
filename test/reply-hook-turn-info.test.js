// T2.4 真实行为测试：reply / reply/items 两个钩子收到同一份回合身份（turnId / topicMode /
// participation / triggerMessageIds），triggerMessageIds 为冻结独立拷贝；旧式监听器只读旧字段零变化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const log = { info() {}, warn() {}, debug() {} }

function fixture({ replyHook, itemsHook, config = {} } = {}) {
  const sent = []
  const delivery = createReplyDelivery({
    getConfig: () => ({
      ownerQQ: 'owner',
      voice: { enabled: false, autoChance: 0 },
      stickers: { enabled: false, autoChance: 0 },
      reply: { maxBubbles: 3, groupMaxChars: 40, ...config },
    }),
    log,
    hooks: { reply: replyHook, items: itemsHook },
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => { sent.push({ chatId, kind: 'text', text }); return { message_id: 1 } },
    sendVoice: async (chatId, text) => { sent.push({ chatId, kind: 'voice', text }); return { message_id: 2 } },
    sendSticker: async () => ({ message_id: 3 }),
    sendImage: async () => ({ message_id: 4 }),
    sendMixed: async (chatId, parts) => { sent.push({ chatId, kind: 'mixed', parts }); return { message_id: 5 } },
    pokeBack: async () => {},
    sleep: async () => {},
    random: () => 0.5,
  })
  return { delivery, sent }
}

test('两个钩子收到同一份身份字段；participation 是字符串级别', async () => {
  const seen = []
  const { delivery } = fixture({
    replyHook: (text, info) => { seen.push(['reply', { ...info }]); return undefined },
    itemsHook: (items, info) => { seen.push(['items', { ...info }]); return undefined },
  })
  const ids = ['10001', '10002']
  await delivery.deliverNow('group:30001', '一|||二', {
    turnId: 'turn-1', topicMode: 'interject', participationLevel: 'text_lite',
    triggerMessageIds: ids, userText: '甲的原话',
  })
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map(([hook]) => hook), ['reply', 'items'])
  const replyInfo = seen[0][1]
  const itemsInfo = seen[1][1]
  // 同一份身份字段
  for (const key of ['turnId', 'topicMode', 'participation', 'triggerMessageIds', 'chatId', 'userText']) {
    assert.deepEqual(replyInfo[key], itemsInfo[key], `两个钩子的 ${key} 一致`)
  }
  assert.equal(replyInfo.turnId, 'turn-1')
  assert.equal(replyInfo.topicMode, 'interject')
  assert.equal(replyInfo.participation, 'text_lite', '字符串级别，不是内部对象')
  assert.equal(typeof replyInfo.participation, 'string')
  assert.deepEqual(replyInfo.triggerMessageIds, ['10001', '10002'])
  assert.deepEqual(itemsInfo.chatId, 'group:30001')
  assert.deepEqual(itemsInfo.userText, '甲的原话')
  assert.ok('text' in itemsInfo, 'reply/items 保留 text 字段')
  assert.equal('text' in replyInfo, false, 'reply 钩子契约不变（没有 text 字段）')
})

test('triggerMessageIds 是冻结的独立拷贝：钩子篡改与调用方后续修改都不影响', async () => {
  let captured = null
  const source = ['10001', '10002']
  const { delivery } = fixture({
    itemsHook: (items, info) => {
      captured = info.triggerMessageIds
      try { captured.push('篡改') } catch (e) { /* 冻结数组会抛 */ }
      return undefined
    },
  })
  const r = await delivery.deliverNow('group:30001', '一', { turnId: 'turn-2', triggerMessageIds: source })
  assert.equal(r.state, 'sent')
  assert.deepEqual(source, ['10001', '10002'], '调用方原始数组不被钩子改写')
  assert.deepEqual([...captured], ['10001', '10002'], '钩子拿到的是独立拷贝')
  assert.equal(Object.isFrozen(captured), true, '且已冻结')
})

test('旧式监听器只读旧字段（chatId / userText / text）行为零变化', async () => {
  const replySeen = []
  const itemsSeen = []
  const { delivery, sent } = fixture({
    // group-topic-boundary 风格：只读 chatId / userText / text，其他字段一概不碰
    replyHook: (text, info) => { replySeen.push({ chatId: info.chatId, userText: info.userText }); return text === '在呢' ? '在呢～' : undefined },
    itemsHook: (items, info) => { itemsSeen.push({ chatId: info.chatId, text: info.text }); return undefined },
  })
  await delivery.deliverNow('group:30001', '在呢', { userText: '你在吗' })
  assert.deepEqual(replySeen, [{ chatId: 'group:30001', userText: '你在吗' }])
  assert.deepEqual(itemsSeen, [{ chatId: 'group:30001', text: '在呢～' }], 'items 钩子看到的是改写后的 text')
  assert.deepEqual(sent.map((s) => s.text), ['在呢～'])
})

test('旧调用方未传新 opts：turnId / topicMode 为 undefined，participation 默认 full，结果形状不变', async () => {
  const replyInfo = {}
  const { delivery, sent } = fixture({
    replyHook: (text, info) => { Object.assign(replyInfo, { ...info }); return undefined },
  })
  const r = await delivery.deliverNow('group:30001', '正常回复', { userText: '原话' })
  assert.equal(r.state, 'sent')
  assert.equal(sent.length, 1)
  assert.equal(replyInfo.turnId, undefined)
  assert.equal(replyInfo.topicMode, undefined)
  assert.equal(replyInfo.participation, 'full', '缺省按 full 处理')
  assert.deepEqual([...replyInfo.triggerMessageIds], [])
})

test('不存在跨聊天混淆：两个聊天的回合身份各自独立', async () => {
  const byChat = new Map()
  const { delivery } = fixture({
    replyHook: (text, info) => { byChat.set(info.chatId, { turnId: info.turnId, ids: [...info.triggerMessageIds] }); return undefined },
  })
  await delivery.deliverNow('group:30001', '回复一', { turnId: 'turn-A', triggerMessageIds: ['10001'] })
  await delivery.deliverNow('group:30002', '回复二', { turnId: 'turn-B', triggerMessageIds: ['20002'] })
  assert.deepEqual(byChat.get('group:30001'), { turnId: 'turn-A', ids: ['10001'] })
  assert.deepEqual(byChat.get('group:30002'), { turnId: 'turn-B', ids: ['20002'] })
  assert.ok(byChat.get('group:30001').turnId !== byChat.get('group:30002').turnId)
})

test('info 对象已冻结：reply 钩子篡改 turnId / participation / triggerMessageIds 不可能污染 items 钩子', async () => {
  const blocked = []
  const itemsSeen = []
  const { delivery, sent } = fixture({
    replyHook: (text, info) => {
      // 冻结对象在严格模式（ESM）下赋值即抛 TypeError —— 逐一尝试并记录
      for (const [key, value] of [['turnId', 'hacked'], ['topicMode', 'hacked'], ['participation', 'react'], ['userText', 'hacked']]) {
        try { info[key] = value; blocked.push(`${key}:未冻结`) } catch (e) { blocked.push(`${key}:frozen`) }
      }
      try { info.triggerMessageIds.push('hacked'); blocked.push('ids:未冻结') } catch (e) { blocked.push('ids:frozen') }
      return undefined
    },
    itemsHook: (items, info) => { itemsSeen.push({ ...info, idsFrozen: Object.isFrozen(info.triggerMessageIds) }); return undefined },
  })
  await delivery.deliverNow('group:30001', '在呢', {
    turnId: 'turn-9', topicMode: 'interject', participationLevel: 'text_lite',
    triggerMessageIds: ['10001', '10002'], userText: '你在吗',
  })
  assert.deepEqual(
    blocked,
    ['turnId:frozen', 'topicMode:frozen', 'participation:frozen', 'userText:frozen', 'ids:frozen'],
    'info 与 triggerMessageIds 都必须只读',
  )
  assert.equal(itemsSeen.length, 1)
  assert.equal(itemsSeen[0].turnId, 'turn-9', 'items 收到的仍是原始回合身份')
  assert.equal(itemsSeen[0].participation, 'text_lite')
  assert.deepEqual(itemsSeen[0].triggerMessageIds, ['10001', '10002'], 'triggerMessageIds 未被篡改')
  assert.equal(itemsSeen[0].idsFrozen, true, 'items 钩子拿到的也是冻结数组')
  assert.deepEqual(sent.map((s) => s.text), ['在呢'])
})
