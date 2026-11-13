// M1-C unknown 发送与媒体 fallback 锁定（modular 重构阶段任务书 M1-C）
//
// 用 fake OneBot 模拟「远端已收到但响应超时 / 连接被掐断」，锁定 legacy 发送链的失败语义：
//   1. 发送类动作（send_* / upload_*）在「副作用可能已发生」的失败（超时、中途断连、响应丢失）
//      上绝不自动重试——unknown 不是 failed，重发就是重复消息（ADR-0001 §3）；
//   2. 只有「确证请求没出门」的网络错误（连接被拒/DNS/不可达）才允许发送类动作重试；
//   3. 媒体约定内 fallback（文件路径→base64、语音→文字）只允许在「确定没发出去」的失败上；
//   4. 没有「以 echo/messageId 冒充发送前幂等」——legacy 本就没有发送侧幂等，两条一样的话
//      就是两次真实发送（测试如实钉住这一事实，投递账本语义在 M2-D Outbox 落地）。
//
// 区别于旧假设：本文件所有重试断言都要求有状态依据（transport+preSend / 业务明确拒绝），
// 「请求失败即可安全重发」的旧假设在发送类动作上已被 client.js 禁止。

import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOneBotClient } from '../src/onebot/client.js'
import { createModularCore } from '../src/host/modular-core.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const cores = []
afterEach(async () => { while (cores.length) await cores.pop().dispose() })

// ---------- 第一部分：OneBot 客户端的失败分类与重试边界 ----------

/** 按动作可编程的假网关：ok / reject（业务拒绝）/ stall（收到不回）/ reset（收完掐线）。 */
async function startProgrammableOneBot() {
  const behavior = { 'send_group_msg': 'ok', 'send_private_msg': 'ok', 'upload_private_file': 'ok', 'get_group_info': 'ok' }
  const seen = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const action = req.url.replace(/^\//, '')
      seen.push(action)
      const mode = behavior[action] ?? 'ok'
      if (mode === 'stall') return // 收到请求但永不响应（客户端超时，副作用可能已发生）
      if (mode === 'reset') { req.socket.destroy(); return } // 响应丢失
      if (mode === 'reject') return res.end(JSON.stringify({ status: 'failed', retcode: 1, message: '网关明确拒绝' }))
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    seen,
    set(action, mode) { behavior[action] = mode },
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)) },
  }
}

const noopLog = { info() {}, warn() {}, debug() {}, error() {} }
// undici 把 1/7/9 等低端口列为坏端口（fetch 直接报 bad port 而不是 ECONNREFUSED），
// 所以「连不上」的端口用「起一个服务再关掉」腾出来的真实空闲端口。
let deadPortUrl = ''
let deadPortServer
before(async () => {
  deadPortServer = createServer(() => {})
  await new Promise((r) => deadPortServer.listen(0, '127.0.0.1', r))
  deadPortUrl = `http://127.0.0.1:${deadPortServer.address().port}`
  await new Promise((r) => deadPortServer.close(r))
})

test('发送类动作：超时 = unknown，绝不重试（副作用可能已发生）', async () => {
  const fake = await startProgrammableOneBot()
  fake.set('send_group_msg', 'stall')
  const client = createOneBotClient({ endpoint: () => ({ httpUrl: fake.url, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  await assert.rejects(
    () => client.call('send_group_msg', { group_id: 1, message: [] }, { timeoutMs: 200, retries: 3 }),
    (e) => e.unknown === true,
  )
  await new Promise((r) => setTimeout(r, 120)) // 给「本该发生的重试」留出时间窗
  assert.equal(fake.seen.filter((a) => a === 'send_group_msg').length, 1, '整个窗口内只允许一次真实请求')
  await fake.close()
})

test('发送类动作：连接被拒（ECONNREFUSED）= 确证请求没出门，允许重试，最终 definite 失败', async () => {
  const client = createOneBotClient({ endpoint: () => ({ httpUrl: deadPortUrl, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  await assert.rejects(
    () => client.call('send_group_msg', { group_id: 1, message: [] }, { timeoutMs: 500, retries: 2 }),
    (e) => e.transport === true && e.preSend === true && e.unknown === false,
  )
})

test('发送类动作：响应被掐断（连接重置）= unknown，不重试', async () => {
  const fake = await startProgrammableOneBot()
  fake.set('send_group_msg', 'reset')
  const client = createOneBotClient({ endpoint: () => ({ httpUrl: fake.url, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  await assert.rejects(
    () => client.call('send_group_msg', { group_id: 1, message: [] }, { timeoutMs: 1000, retries: 3 }),
    (e) => e.unknown === true,
  )
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(fake.seen.filter((a) => a === 'send_group_msg').length, 1, '掐线后不许补发第二遍')
  await fake.close()
})

test('发送类动作：网关明确拒绝（业务错误）= definite 失败，不重试也不算 unknown', async () => {
  const fake = await startProgrammableOneBot()
  fake.set('send_group_msg', 'reject')
  const client = createOneBotClient({ endpoint: () => ({ httpUrl: fake.url, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  await assert.rejects(
    () => client.call('send_group_msg', { group_id: 1, message: [] }, { timeoutMs: 1000, retries: 3 }),
    (e) => e.unknown === false && e.transport === false,
  )
  assert.equal(fake.seen.filter((a) => a === 'send_group_msg').length, 1, '业务拒绝重试无意义')
  await fake.close()
})

test('查询类动作语义不变：连接被拒照样重试（幂等查询允许），超时不重试', async () => {
  // 拒绝→拒绝→成功：证明查询类在 preSend 类网络错误上仍会重试
  const behavior = { n: 0 }
  const server = createServer((req, res) => {
    behavior.n++
    if (behavior.n <= 2) { req.socket.destroy(); return }
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { group_id: 1 } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const client = createOneBotClient({ endpoint: () => ({ httpUrl: `http://127.0.0.1:${server.address().port}`, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  const r = await client.call('get_group_info', { group_id: 1 }, { timeoutMs: 1000, retries: 3 })
  assert.equal(r.group_id, 1)
  assert.equal(behavior.n, 3, '前两次掐线都重试了')
  await new Promise((r2) => server.close(r2))

  // 查询超时：不是 transport（可能已处理），维持不重试的 legacy 语义
  const fake = await startProgrammableOneBot()
  fake.set('get_group_info', 'stall')
  const client2 = createOneBotClient({ endpoint: () => ({ httpUrl: fake.url, wsUrl: '' }), log: noopLog, retryDelays: [10, 10, 10] })
  await assert.rejects(() => client2.call('get_group_info', { group_id: 1 }, { timeoutMs: 200, retries: 3 }))
  await new Promise((r2) => setTimeout(r2, 120))
  assert.equal(fake.seen.filter((a) => a === 'get_group_info').length, 1)
  await fake.close()
})

// ---------- 第二部分：hub 投递面（文件/语音 fallback 的状态依据） ----------

let workDir
let mock
let hub
let wavFile

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'delivery-lock-'))
  process.env.AURABOT_DATA_DIR = workDir
  // 最小合法 WAV（voice 的 speak 产物只要能被 readFileSync 读就行）
  wavFile = join(workDir, 'fake-voice.wav')
  writeFileSync(wavFile, Buffer.alloc(64, 7))
})

after(async () => {
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

async function buildHub() {
  mock = (await import('./helpers/mock-onebot.js')).startMockOneBot
  const gw = await mock({ selfId: '20000002' })
  const cfg = {
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    workspaceDir: workDir,
    files: { enabled: true, maxMB: 50, dirs: [workDir] },
    stickers: { enabled: false, faces: false, autoChance: 0 },
    voice: { enabled: false, engine: 'off', autoChance: 0 },
    group: { interjectChance: 0 },
    merge: { waitSec: 0.1, maxSec: 1 },
    snowluma: { autoStart: false, autoAttach: false },
  }
  const dsh = createFakeDsh({ brain: async () => '嗯' })
  // 直接用真实 OneBot 客户端包住 mock 网关，重试节奏用测试值
  const gwClient = createOneBotClient({
    endpoint: () => ({ httpUrl: gw.httpUrl, wsUrl: '', httpToken: gw.token, wsToken: '' }),
    log: noopLog,
    retryDelays: [10, 10, 10],
  })
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot: gwClient,
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
    stickers: {},
    tts: { speak: async () => ({ file: wavFile, engine: 'fake' }) },
    buildTools: () => [],
  })
  cores.push(core)
  return { hub: core.services, gw, cfg }
}

test('发文件：网关明确拒绝路径上传 → 允许约定内 base64 重试（第二发成功）', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    const file = join(workDir, 'ok.txt')
    writeFileSync(file, 'hello')
    gw.state.failUploadPath = true // 路径形态必被拒（模拟网关看不到本机盘），base64 放行
    const r = await h.sendFile(`private:10000001`, file, 'ok.txt')
    assert.ok(r, 'base64 重试应当成功')
    const uploads = gw.sent('upload_private_file')
    assert.equal(uploads.length, 2, '恰好两次：路径被拒 + base64 成功')
    assert.ok(String(uploads[1].params.file).startsWith('base64://'), '第二发走 base64')
  } finally {
    gw.state.failUploadPath = false
    await gw.close()
  }
})

test('发文件：上传结果未知（响应被掐断）→ 不做 base64 重试，只此一发', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    const file = join(workDir, 'maybe.txt')
    writeFileSync(file, 'data')
    gw.state.resetActions = new Set(['upload_private_file'])
    await assert.rejects(() => h.sendFile(`private:10000001`, file, 'maybe.txt'), /发文件失败/)
    assert.equal(gw.sent('upload_private_file').length, 1, 'unknown 状态下绝不允许第二发')
  } finally {
    gw.state.resetActions = new Set()
    await gw.close()
  }
})

test('发语音：确定失败（网关拒绝语音条）→ 约定内改发文字（legacy 文档行为）', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    gw.state.failRecord = true // record 段必被拒（确定失败）
    const ok = await h.sendVoice('private:10000001', '今天天气不错')
    assert.equal(ok, false, '语音没发出去')
    const texts = gw.sent('send_private_msg').filter((c) => (c.params.message || []).some((s) => s.type === 'text' && String(s.data?.text || '').includes('今天天气不错')))
    assert.equal(texts.length, 1, '确定失败后改发文字一次（约定内 fallback）')
    const records = gw.sent('send_private_msg').filter((c) => (c.params.message || []).some((s) => s.type === 'record'))
    assert.equal(records.length, 1, '语音条恰好尝试一次')
  } finally {
    gw.state.failRecord = false
    await gw.close()
  }
})

test('发语音：结果未知（响应被掐断）→ 不改发文字、不重试（零迟到副作用）', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    gw.state.resetActions = new Set(['send_private_msg'])
    const ok = await h.sendVoice('private:10000001', '这句可能已经出去了')
    assert.equal(ok, false)
    const calls = gw.sent('send_private_msg')
    assert.equal(calls.length, 1, '只有语音条这一次请求，unknown 后零追加')
    assert.equal(calls[0].params.message.filter((s) => s.type === 'text').length, 0, '没有偷偷改发文字')
  } finally {
    gw.state.resetActions = new Set()
    await gw.close()
  }
})

test('发送侧没有幂等伪装：同一句话两次调用就是两次真实发送（echo/messageId 不当幂等键）', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    await h.sendText('private:10000001', '重复一句话')
    await h.sendText('private:10000001', '重复一句话')
    assert.equal(gw.sent('send_private_msg').length, 2, 'legacy 无发送侧幂等：两条都真实出门（如实钉住，账本语义归 M2-D）')
  } finally {
    await gw.close()
  }
})

test('发送回执不伪造：成功才返回网关 messageId，失败/超时返回 null 而不是编一个', async () => {
  const { hub: h, gw } = await buildHub()
  try {
    const r = await h.sendText('private:10000001', '正常消息')
    assert.ok(r && typeof r.message_id === 'number', '成功时回执是网关真实 messageId')

    gw.state.resetActions = new Set(['send_private_msg'])
    const bad = await h.sendText('private:10000001', '发不出去的消息')
    assert.equal(bad, null, '失败返回 null，绝不拿 echo/queued/sim 冒充回执')
  } finally {
    gw.state.resetActions = new Set()
    await gw.close()
  }
})
