// flag-off 真实装配回归（合并确认书第 3 条 / 复核报告 §6.3 补口）
//
// 旧 M4-6 用例只断言 isModularCoreEnabled(默认env)===false，没有实际跑 host 的 flag-off 装配路径。
// 本文件用完整 host（fake DSH + mock OneBot + 临时数据目录）断言三件事：
//   1) flag 关（默认 env）时 host 正常装载并走 legacy 主链回复；
//   2) 新核心的持久化痕迹（deliveries.json / modular-sessions.json）一个都不存在——
//      证明 flag-off 态 createModularCore 真的零装配（而不是装了不用）；
//   3) legacy 入口 ACL 行为不受新核心影响：白名单外私聊仍被旧链拒绝（零回复）。

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { isModularCoreEnabled } from '../src/kernel/legacy-fallback.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OWNER = '10000001'
const BOT = '20000002'
const priv = (user_id, message) => ({
  message_type: 'private', sub_type: 'friend', user_id: Number(user_id),
  message_id: Math.floor(Math.random() * 1e6), time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(user_id), nickname: user_id === OWNER ? 'xiaoming' : '路人' }, message,
})
const text = (t) => [{ type: 'text', data: { text: t } }]

let mock, fake, api, dataDir

before(async () => {
  // 关键：flag 环境变量必须缺席（不是设 false），才等价于真实默认部署形态
  delete process.env.FLAG_MODULAR_CORE
  assert.equal(isModularCoreEnabled(process.env), false, '前置：默认 env 下 flag 关')

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
  assert.ok(mock.connected() > 0, 'flag-off host 装载并连上 mock 网关')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

test('flag-off：legacy 主链真实回复（旧核心完好，非空壳装载）', async () => {
  const beforeCount = mock.sent('send_private_msg').length
  mock.push(priv(OWNER, text('在吗')))
  for (let i = 0; i < 120 && mock.sent('send_private_msg').length === beforeCount; i++) await sleep(50)
  assert.ok(mock.sent('send_private_msg').length > beforeCount, 'legacy 路径收到并回复了主人私聊')
  assert.match(JSON.stringify(mock.sent('send_private_msg').at(-1).params.message), /在呀/)
})

test('flag-off：新核心零装配——持久化痕迹一个都不该出现', () => {
  const files = readdirSync(dataDir)
  for (const marker of ['deliveries.json', 'modular-sessions.json']) {
    assert.equal(files.includes(marker), false, `flag-off 却发现了新核心痕迹文件 ${marker}`)
  }
  // legacy 自己的会话文件应存在（证明流量确实经过了旧主链的持久化，而不是两边都没跑）
  assert.equal(files.includes('sessions.json'), true, 'legacy sessions.json 应存在')
})

test('flag-off：legacy 入口 ACL 不受新核心影响——白名单外私聊零回复', async () => {
  const beforeCount = mock.sent('send_private_msg').length
  mock.push(priv('99999999', text('在吗')))
  await sleep(600) // 给足异步窗口；正确行为是入口就拒，不该有任何发送
  assert.equal(mock.sent('send_private_msg').length, beforeCount, '白名单外的私聊在 legacy 入口被拒')
})
