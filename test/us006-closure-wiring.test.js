// US-006 接线验收：四态会话收尾真正作用于回复分条。
// 重点：CLOSED 只锁主动搭话，不锁入站回复；群聊不套用私聊紧缩。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

/** 最小 delivery：捕获实际投递的 items，不碰网络。 */
function harness({ text, chatId = 'private:1000', cfgOver = {} } = {}) {
  const sent = []
  const logs = []
  const cfg = {
    reply: { maxBubbles: 6, groupMaxChars: 40, privateMaxChars: 120 },
    voice: { enabled: false },
    ...cfgOver,
  }
  const capture = (kind) => async (chatId, value) => {
    sent.push([{ kind, value }])
    return { messageId: 'm' + sent.length }
  }
  const d = createReplyDelivery({
    getConfig: () => cfg,
    log: { info: (m) => logs.push(String(m)), warn: () => {} },
    groups: { leaveTopic: () => {}, refs: () => ({}), enter: () => {}, noteSpeak: () => {}, noteSpokeInGroup: () => {}, decide: () => true },
    sendText: capture('text'),
    sendVoice: capture('voice'),
    sendSticker: capture('sticker'),
    sendImage: capture('image'),
    sendMixed: async (chatId, items) => { sent.push(items); return { messageId: 'm' + sent.length } },
    pokeBack: async () => {},
    logChat: () => {},
    onActivity: () => {},
    onDelivered: () => {},
    sleep: async () => {},
    reportTurns: new Map(),
    interaction: { queueAside: () => {}, claimPoke: () => false, releasePoke: () => {} },
    stickers: { put: () => {} },
    isCaptured: () => false,
    outbox: () => null,
  })
  return { d, sent, logs, cfg }
}

test('正常一轮：maxBubbles 按配置放行，不被收尾算法误压', async () => {
  const { d, sent } = harness()
  await d.deliver('private:1000', '第一句|||第二句|||第三句', { userText: '你好呀今天过得怎么样' })
  assert.ok(sent.length >= 1, '应至少投递一次')
  const items = sent.flat()
  const texts = items.filter((i) => i.kind === 'text')
  assert.ok(texts.length >= 2, `正常轮次不该被压成 1 条，实际 ${texts.length}`)
})

test('短句不触发紧缩：中文 3-4 字是正常回话', async () => {
  const { d, sent } = harness()
  await d.deliver('private:1000', '甲|||乙|||丙', { userText: '好的' })
  const texts = sent.flat().filter((i) => i.kind === 'text')
  assert.ok(texts.length >= 2, `单条短句不该压成 1 条，实际 ${texts.length}`)
})

test('明确道别后仍会回复（CLOSED 不锁入站回复）', async () => {
  const { d, sent } = harness()
  await d.deliver('private:1000', '晚安，早点睡', { userText: '晚安' })
  assert.ok(sent.length >= 1, 'CLOSED 只锁主动搭话，用户再说话必须回')
})

test('群聊不套用私聊四态紧缩', async () => {
  const { d, sent } = harness({ chatId: 'group:558' })
  await d.deliver('group:558', '一|||二|||三', { userText: '好的' })
  const texts = sent.flat().filter((i) => i.kind === 'text')
  assert.ok(texts.length >= 2, `群聊不该被压成 1 条，实际 ${texts.length}`)
})

test('连续附和累积到阈值后收紧气泡数（私聊）', async () => {
  const { d, sent } = harness()
  // 连续多轮单字附和 → 状态机进入 yielding，allowQuestion=false
  for (const t of ['嗯', '嗯', '嗯', '嗯']) {
    await d.deliver('private:1000', '好的呀？', { userText: t })
  }
  const texts = sent.flat().filter((i) => i.kind === 'text')
  assert.ok(texts.length > 0, '仍应正常回复')
  // 至少有一次末尾问号被去掉（不追问）
  assert.ok(sent.flat().some((i) => i.kind === 'text' && !/[?？]\s*$/.test(i.value)),
    '收紧后不该以问句结尾追问')
})

test('未提供 userText 时不影响投递（不崩）', async () => {
  const { d, sent } = harness()
  await assert.doesNotReject(() => d.deliver('private:1000', '随便说点什么'))
  assert.ok(sent.length >= 1)
})
