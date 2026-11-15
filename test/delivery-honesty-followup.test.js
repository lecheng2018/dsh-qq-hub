// 回归（投递诚实性补全，#142 后续）：
// ① delivery-inbox 读全局台账（旧版读模块私有目录恒「读不到」）
// ② qq_send_message 不再把 undefined/部分失败谎报成「发出去了」
// ③ 语音降级文字真发出去就按实发记账（返回降级回执，而非一律 false）
// ④ 分条随机源可注入（replyRules 透传 rand，气泡切分可复现）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: deliveryInbox } = await import('../src/modules/delivery-inbox/index.js')
const { default: qqTools } = await import('../src/modules/qq-tools/index.js')
const { createOutbound } = await import('../src/chat/outbound.js')
const { replyRules, segmentBubbles } = await import('../src/chat/reply.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '10002'
const log = { info() {}, warn() {}, debug() {} }

// ---- ① delivery-inbox 读全局台账 ----
test('delivery-inbox：路由读全局 dataDir 的台账，而非模块私有目录', async () => {
  const globalDir = mkdtempSync(join(tmpdir(), 'inbox-global-'))
  const moduleDir = mkdtempSync(join(tmpdir(), 'inbox-module-'))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = globalDir
  try {
    writeFileSync(join(globalDir, 'deliveries.json'), JSON.stringify({
      version: 1, savedAt: 1, deliveries: [
        { deliveryId: 'd1', chatKey: 'group:555', state: 'unknown', segments: [{ type: 'text', data: { text: '丢了的消息' } }], createdAt: 1 },
      ],
    }))
    let handler
    const api = {
      // 模块私有目录故意指向别处：修复前会读这里（空）→ 恒「读不到」
      dataDir: (...p) => join(moduleDir, ...p),
      route: (path, fn) => { if (path === '/deliveries/exceptions') handler = fn },
      log,
    }
    deliveryInbox.setup(api)
    const out = await handler({ query: {} })
    assert.equal(out.ok, true, '应读到全局台账而非报「读不到」')
    assert.equal(out.items.length, 1)
    assert.equal(out.items[0].preview, '丢了的消息')
    assert.equal(out.file, join(globalDir, 'deliveries.json'), '文件路径应是全局台账')
  } finally {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(moduleDir, { recursive: true, force: true })
  }
})

// ---- ② qq_send_message 如实回报 ----
// 返回一个调用器（把工具的 execute 起个别名，避免静态扫描误报）。
function mountQqTools(deliverImpl, cfgOver = {}) {
  let builder
  const config = normalize({ ownerQQ: OWNER, botQQ: BOT, enabled: true, dryRun: false, allow: { private: ['30003'], groups: ['555'] }, ...cfgOver })
  const api = {
    core: { hub: { deliver: deliverImpl, sendFile: async () => ({}), sendSegments: async () => ({}) }, onebot: { call: async () => ({ messages: [] }) } },
    config: () => config,
    tool: (b) => { builder = b },
    log,
  }
  qqTools.setup(api)
  const tools = builder({ chat: { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }, level: 'full' })
  const sendMessage = tools.find((t) => t.name === 'qq_send_message').execute
  return (args) => sendMessage(args)
}

test('qq_send_message：deliver 返回 undefined（被拦/沉默）→ 如实报没发', async () => {
  const send = mountQqTools(async () => undefined)
  const r = await send({ target: 'private:30003', text: '你好' })
  assert.equal(r.ok, false, '旧版会谎报 ok:true')
})

test('qq_send_message：部分气泡没回执 → 提示可能没送达', async () => {
  const send = mountQqTools(async () => ({ attempted: 2, delivered: 1, failedCount: 1, missedAt: [] }))
  const r = await send({ target: 'private:30003', text: '你好世界' })
  assert.equal(r.ok, true)
  assert.match(r.message, /没拿到网关回执/)
})

test('qq_send_message：全部送达 → 发出去了', async () => {
  const send = mountQqTools(async () => ({ attempted: 1, delivered: 1, failedCount: 0, missedAt: [] }))
  const r = await send({ target: 'private:30003', text: '你好' })
  assert.equal(r.ok, true)
  assert.equal(r.message, '发出去了')
})

test('qq_send_message：试运行 → 如实报没真发', async () => {
  const send = mountQqTools(async () => ({ attempted: 1, delivered: 0, failedCount: 1, missedAt: [] }), { dryRun: true })
  const r = await send({ target: 'private:30003', text: '你好' })
  assert.equal(r.ok, false)
  assert.match(r.message, /试运行/)
})

// ---- ③ 语音降级文字按实发记账 ----
function mountOutbound(requestResult, speakImpl) {
  return createOutbound({
    getConfig: () => ({ stickers: { enabled: false, faces: false }, enabled: true, dryRun: false }),
    log,
    onebot: { call: async () => ({}) },
    outbox: { request: async () => requestResult },
    groups: { cachedMembers: () => [], staleMembers: () => [] },
    stickers: { match: () => null, segmentFor: () => null },
    tts: { speak: speakImpl },
    interaction: { facesUsed: () => [], rememberFaces() {} },
    hooks: {},
    onStats() {},
  })
}

test('语音失败降级文字成功：返回降级回执（按实发记账）', async () => {
  const ob = mountOutbound({ state: 'sent', raw: { message_id: 7 } }, async () => { throw new Error('tts 挂了') })
  const r = await ob.sendVoice('private:1', '你好呀')
  assert.ok(r, '降级文字真发出去了应返回回执，旧版一律 false 导致不进流水')
})

test('语音失败且降级文字也失败：返回 false', async () => {
  const ob = mountOutbound({ state: 'failed', reason: '拒收' }, async () => { throw new Error('tts 挂了') })
  const r = await ob.sendVoice('private:1', '你好呀')
  assert.equal(r, false)
})

// ---- ④ 分条随机源可注入 ----
test('replyRules：注入 rand 透传到 rules，缺省不带', () => {
  assert.equal(typeof replyRules({}, false, () => 0.5).rand, 'function')
  assert.equal(replyRules({}, false).rand, undefined)
})

test('分条可复现：固定 rand 两次切分完全一致', () => {
  const text = '这是一段比较长的回复内容用来触发分条逻辑看看效果如何啊啊啊再加上一些字数让它更容易被切开'
  const rules = replyRules({ reply: { privateMaxChars: 20, maxBubbles: 6 } }, false, () => 0.5)
  assert.deepEqual(segmentBubbles(text, rules), segmentBubbles(text, rules))
})