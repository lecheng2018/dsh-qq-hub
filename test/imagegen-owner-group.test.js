import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const MEMBER = '10000002'
const BOT = '20000002'
const GROUP = '66770001'
const DATA = mkdtempSync(join(tmpdir(), 'aurabot-imagegen-owner-group-'))
const PNG = Buffer.alloc(64)
PNG.set(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
PNG.writeUInt32BE(256, 16)
PNG.writeUInt32BE(256, 20)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = fn()
    if (result) return result
    await wait(25)
  }
  throw new Error('等不到条件成立')
}

let mock, fake, api, imageServer, imageCalls = 0, messageId = 1

before(async () => {
  process.env.AURABOT_DATA_DIR = DATA
  process.env.AURABOT_WORKSPACE = join(DATA, 'workspace')
  process.env.FLAG_MODULAR_CORE = 'true'
  mock = await startMockOneBot({ selfId: BOT })
  imageServer = createServer(async (req, res) => {
    for await (const _ of req) {}
    imageCalls++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(DATA, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [GROUP] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(DATA, 'none') },
    group: { interjectChance: 0, quota: { enabled: false } },
    merge: { waitSec: 0.1, maxSec: 1, groupWaitSec: 0.2, groupMaxSec: 1 },
    model: { vision: 'off' },
    imageGen: { enabled: true, ownerOnly: true, baseUrl: `http://127.0.0.1:${imageServer.address().port}/v1`, model: 'test-image' },
    voice: { enabled: false },
    bridge: { http: true, token: 'imagegen-panel-admin-token' },
  }))
  fake = createFakeDsh({
    brain: async ({ text, callTool }) => {
      if (!String(text).includes('请求生图标记')) return '收到'
      const result = await callTool('qq_draw_image', { prompt: '群主热修回归图' })
      return result?.ok ? '画好了' : `生图被拒：${result?.message || '工具不可用'}`
    },
  })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect', {})
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  if (imageServer?.listening) await new Promise((resolve) => imageServer.close(resolve))
})

const groupMessage = (userId, text, { mention = false, replyId = '' } = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal',
  self_id: Number(BOT), group_id: Number(GROUP), user_id: Number(userId), message_id: messageId++,
  message: [
    ...(replyId ? [{ type: 'reply', data: { id: replyId } }] : []),
    ...(mention ? [{ type: 'at', data: { qq: BOT } }] : []),
    { type: 'text', data: { text } },
  ],
  sender: { user_id: Number(userId), nickname: userId === OWNER ? '主人' : '群友', card: userId === OWNER ? '主人' : '群友', role: 'member' },
})
const privateMessage = (text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), message_id: messageId++,
  message: [{ type: 'text', data: { text } }], sender: { user_id: Number(OWNER), nickname: '主人' },
})
const toolCallFor = (turn) => turn?.toolCalls?.find((call) => call.name === 'qq_draw_image')

async function runTurn (events, marker) {
  const start = fake.turns.length
  for (const event of events) {
    mock.push(event)
    await wait(40)
  }
  const turn = await until(() => fake.turns.slice(start).find((item) => item.userText.includes(marker)))
  const call = toolCallFor(turn)
  assert.ok(call, `模型应尝试调用生图工具，turn=${JSON.stringify(turn)}`)
  return call
}

test('主人唯一 @机器人的生图请求：群友同轮插话不再误拒', async () => {
  const before = imageCalls
  const call = await runTurn([
    groupMessage(OWNER, '请求生图标记：给我画一只鲸鱼', { mention: true }),
    groupMessage(MEMBER, '顺便用蓝色背景'),
  ], '请求生图标记')
  assert.equal(call.result.ok, true, JSON.stringify(call.result))
  assert.equal(imageCalls, before + 1, '应实际调用生图服务')
})

test('上一轮主人明确请求不让下一轮重复同句借权', async () => {
  const request = '请求生图标记：画一只鲸鱼'
  const allowed = await runTurn([
    groupMessage(OWNER, request, { mention: true }),
  ], '请求生图标记')
  assert.equal(allowed.result.ok, true, JSON.stringify(allowed.result))

  const before = imageCalls
  const call = await runTurn([
    groupMessage(OWNER, request),
    groupMessage(MEMBER, '请看看这条', { mention: true }),
  ], '请求生图标记')
  assert.equal(call.result.ok, false, '前一轮 @ 不能授权下一轮同一句未 @ 请求')
  assert.match(call.result.message, /只给主人画/)
  assert.equal(imageCalls, before)
})

test('多人分别明确 @机器人时不猜请求者，也不调用生图服务', async () => {
  const before = imageCalls
  const call = await runTurn([
    groupMessage(OWNER, '请求生图标记：画一只鲸鱼', { mention: true }),
    groupMessage(MEMBER, '我也要，请求生图标记：画一只猫', { mention: true }),
  ], '请求生图标记')
  assert.equal(call.result.ok, false, '多人明确请求不能借权')
  assert.match(call.result.message, /只给主人画/)
  assert.equal(imageCalls, before, '权限拒绝必须发生在服务调用前')
})

test('借权不会留到下一轮，后续群友 @机器人不能继承主人权限', async () => {
  const before = imageCalls
  const call = await runTurn([
    groupMessage(MEMBER, '请求生图标记：画一只猫', { mention: true }),
  ], '请求生图标记')
  assert.equal(call.result.ok, false, '前一轮的主人请求不能沿用到本轮')
  assert.match(call.result.message, /只给主人画/)
  assert.equal(imageCalls, before)
})

test('引用机器人的主人请求也可借权，主人私聊生图权限保持不变', async () => {
  const before = imageCalls
  const replyId = '990001'
  mock.state.messages = {
    ...(mock.state.messages || {}),
    [replyId]: { message_id: Number(replyId), sender: { user_id: Number(BOT), nickname: '机器人' }, message: [{ type: 'text', data: { text: '你想画什么？' } }] },
  }
  const quoted = await runTurn([
    groupMessage(OWNER, '请求生图标记：画一只鲸鱼', { replyId }),
    groupMessage(MEMBER, '我觉得背景可以是蓝色'),
  ], '请求生图标记')
  assert.equal(quoted.result.ok, true, JSON.stringify(quoted.result))
  assert.equal(imageCalls, before + 1)

  const privateCall = await runTurn([privateMessage('请求生图标记：画一只鲸鱼')], '请求生图标记')
  assert.equal(privateCall.result.ok, true, JSON.stringify(privateCall.result))
  assert.equal(imageCalls, before + 2)
})
