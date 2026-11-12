// K-03C 旧开关退出回归：FLAG_MODULAR_CORE=false 不再启用 legacy。
// 保留原真实装配的行为断言：主人回复、ACL、二进制入站；同时核对当前核心的持久化归属。

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OWNER = '10000001'
const BOT = '20000002'
const priv = (user_id, message) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(user_id),
  self_id: Number(BOT), message_id: Math.floor(Math.random() * 1e6), time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(user_id), nickname: user_id === OWNER ? 'xiaoming' : '路人' }, message,
})
const text = (t) => [{ type: 'text', data: { text: t } }]

let mock, fake, api, dataDir

before(async () => {
  process.env.FLAG_MODULAR_CORE = 'false'
  dataDir = mkdtempSync(join(tmpdir(), 'flagoff-e2e-'))
  process.env.AURABOT_DATA_DIR = dataDir
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0, quota: { enabled: false } },
    merge: { waitSec: 0.05, maxSec: 0.2 },
  }))
  fake = createFakeDsh({ brain: async () => '在呀' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect', {})
  for (let i = 0; i < 100 && mock.connected() === 0; i++) await sleep(100)
  assert.ok(mock.connected() > 0, '旧 env 值不影响当前核心装载和网关连接')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

test('旧 flag 关闭值：当前核心仍真实回复，不回退 legacy', async () => {
  const beforeCount = mock.sent('send_private_msg').length
  mock.push(priv(OWNER, text('在吗')))
  for (let i = 0; i < 120 && mock.sent('send_private_msg').length === beforeCount; i++) await sleep(50)
  assert.ok(mock.sent('send_private_msg').length > beforeCount, '当前核心收到并回复主人私聊')
  assert.match(JSON.stringify(mock.sent('send_private_msg').at(-1).params.message), /在呀/)
})

test('旧 flag 关闭值：持久化只归当前核心，不创建旧 sessions.json', () => {
  const files = readdirSync(dataDir)
  assert.equal(files.includes('deliveries.json'), true)
  assert.equal(files.includes('modular-sessions.json'), true)
  assert.equal(files.includes('sessions.json'), false, '不得重新启用旧会话事实表')
})

test('旧 flag 关闭值：白名单外私聊仍零回复', async () => {
  const beforeCount = mock.sent('send_private_msg').length
  mock.push(priv('99999999', text('在吗')))
  await sleep(600)
  assert.equal(mock.sent('send_private_msg').length, beforeCount)
})

test('旧 flag 关闭值：当前核心入站二进制文件实际落盘', async () => {
  const event = priv(OWNER, [{
    type: 'file',
    data: { file_name: '资料.bin', base64: `base64://${Buffer.from([0, 1, 2, 3]).toString('base64')}` },
  }])
  mock.push(event)
  let turn
  for (let i = 0; i < 100; i++) {
    turn = fake.turns.find((item) => String(item.userText).includes('资料.bin'))
    if (turn) break
    await sleep(50)
  }
  const body = String(turn?.userText || '')
  assert.match(body, /已经存在 .*qq-inbox.*要看得用工具读/)
  assert.doesNotMatch(body, /mkdir is not defined|writeFile is not defined/)
  const file = body.match(/已经存在 (.+?)，要看得用工具读/)?.[1]
  assert.ok(file && existsSync(file), '落盘文件必须真实存在')
})
