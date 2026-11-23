// 回归（上游遗留缺陷①）：表情发送如实记账。
// 旧版 sendSticker 丢掉 sendSegments 的返回值、无条件 return true，网关拒收/状态未知时
// 上层仍按「已送达」计，markUsed/onStats 也照记。修复后：拿到回执才算成功，失败不记使用/统计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutbound } from '../src/chat/outbound.js'

const log = { info() {}, warn() {}, debug() {} }
const item = { md5: 'abcdef123456', name: '笑' }

function fixture(requestResult) {
  const used = []
  const stats = []
  const noted = [] // 本回合表情台账（chat/turn-stickers.js）
  const outbound = createOutbound({
    getConfig: () => ({ stickers: { enabled: true } }),
    log,
    onebot: { call: async () => [] },
    outbox: { request: async () => requestResult },
    groups: { cachedMembers: () => [], staleMembers: () => [] },
    stickers: {
      match: () => item,
      segmentFor: () => ({ type: 'image', data: { file: 'sticker' } }),
      markUsed: (md5) => used.push(md5),
    },
    tts: {},
    interaction: {},
    hooks: {},
    onStats: (kind) => stats.push(kind),
    turnStickers: { note: (chatId, md5) => noted.push([chatId, md5]) },
  })
  return { outbound, used, stats, noted }
}

test('表情拿到网关回执：返回回执、记一次使用与统计', async () => {
  const { outbound, used, stats } = fixture({ state: 'sent', raw: { message_id: 42 } })
  const receipt = await outbound.sendSticker('private:1', item)
  assert.ok(receipt, '成功应返回回执（与 sendText/sendImage 同口径）')
  assert.deepEqual(used, [item.md5], '成功才记 markUsed')
  assert.ok(stats.includes('stickers'), '成功才记表情统计')
})

test('表情被网关拒收：返回 false，且不记使用/统计', async () => {
  const { outbound, used, stats } = fixture({ state: 'failed', reason: '网关拒收' })
  const receipt = await outbound.sendSticker('private:1', item)
  assert.equal(receipt, false, '失败必须如实返回 false，不能谎报 true')
  assert.deepEqual(used, [], '失败不该记 markUsed')
  assert.ok(!stats.includes('stickers'), '失败不该记表情统计')
})

test('表情状态未知：同样按未送达处理，不记使用/统计', async () => {
  const { outbound, used, stats } = fixture({ state: 'unknown' })
  const receipt = await outbound.sendSticker('private:1', item)
  assert.equal(receipt, false)
  assert.deepEqual(used, [])
  assert.ok(!stats.includes('stickers'))
})
test('表情真的发出去才记本回合台账：同回合正文里重复的那张据此去重', async () => {
  const { outbound, noted } = fixture({ state: 'sent', raw: { message_id: 43 } })
  await outbound.sendSticker('group:7', item)
  assert.deepEqual(noted, [['group:7', item.md5]], '成功发送 → 记账（chatId + md5）')
})

test('表情没发出去不记台账：不能把没发的算成「本轮发过」', async () => {
  const { outbound, noted } = fixture({ state: 'failed', reason: '网关拒收' })
  await outbound.sendSticker('group:7', item)
  assert.deepEqual(noted, [])
})
