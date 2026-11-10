// M1-B backfill 行为锁定（modular 重构阶段任务书 M1-B）
//
// 锁定 legacy 补收链（src/chat/backfill.js 纯库 + src/host/gateway.js 接线）的关键行为，
// 防止后续模块迁移放大旧问题：
//   1. 命令、审批、动态码在补收中绝不执行（迟到副作用为零）；
//   2. 过旧（> maxAgeMinutes）消息不主动唤醒（backfill.js 头注安全承诺 #3）；
//   3. 相同历史重复拉取不重复执行（messageId 去重，实时/补收竞争实时优先）；
//   4. 有效普通消息不丢。
//
// 网关层用本地 fake OneBot HTTP 服务驱动真实 createGateway + 真实 onebot client；
// hub/dangerGuard/mods 为记录桩。
//
// 注意：gateway 的 settleMs 取值用 `Number(...) || 10_000`，0 会被当成未设置回退 10s
// （与 normalizeBackfillConfig 允许 0 不一致——记为 legacy 怪癖），测试用 10ms。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUpstreamGapTracker, createSeenMessageIds, selectBackfill, isCommandLike, plainTextOf, backfillNoticeBlock } from '../src/chat/backfill.js'
import { createGateway } from '../src/host/gateway.js'

// ---------- 纯库层 ----------

test('isCommandLike：斜杠命令、全角斜杠、4-8 位动态码、审批词（可带编号）都要拦', () => {
  const blocked = ['/reset', '／status', '通过 123', '同意#12', '拒绝 456。', '123456', 'pass 1', 'no', 'ok']
  for (const t of blocked) assert.equal(isCommandLike(t), true, `应判为命令类：${t}`)
  const allowed = ['你好呀', '今天天气不错', '112', '123456789', '通过一下嘛再聊两句', '', 'confirm']
  for (const t of allowed) assert.equal(isCommandLike(t), false, `不应误拦：${t}`)
})

test('plainTextOf：只拼接 text 段；非数组返回空', () => {
  assert.equal(plainTextOf([{ type: 'text', data: { text: 'a' } }, { type: 'face', data: {} }, { type: 'text', data: { text: 'b' } }]), 'ab')
  assert.equal(plainTextOf('raw'), 'raw')
  assert.equal(plainTextOf(null), '')
})

test('selectBackfill：窗口过滤、去重（uniq + seen）、过滤自己、按时间升序、限量保最新、命令类单列', () => {
  const now = 1_763_000_000_000
  const msg = (id, timeSec, text, uid = 100) => ({ message_id: id, time: timeSec, user_id: uid, message: [{ type: 'text', data: { text } }] })
  const seen = createSeenMessageIds()
  seen.add('private:100', 3) // 3 号已处理过（比如实时先到）
  const msgs = [
    msg(1, (now - 60_000) / 1000, '最旧'),                       // 正常
    msg(2, (now - 30_000) / 1000, '/reset'),                     // 命令 → skippedCommands
    msg(3, (now - 20_000) / 1000, '已处理过的'),                 // seen → 丢弃
    msg(3, (now - 19_000) / 1000, '重复拉到的同一条'),         // uniq → 丢弃
    msg(4, (now - 10_000) / 1000, '自己发的', 555),              // selfId 过滤（传入 selfId=555）
    msg(5, (now - 5_000) / 1000, '最新'),
  ]
  const r = selectBackfill(msgs, { key: 'private:100', since: now - 120_000, now, selfId: 555, seen, config: { maxPerConversation: 2 } })
  assert.deepEqual(r.items.map((x) => x.event.message_id), [1, 5], '普通消息按时间序保留且限量保最新')
  assert.deepEqual(r.skippedCommands.map((x) => x.event.message_id), [2], '命令类单独列出，绝不混进待投递')
  assert.ok(r.items.every((x) => !x.tooOld), '窗口内的不算过旧')
})

test('selectBackfill：超过 maxAgeMinutes 标 tooOld（仍保留在 items，由接线层决定不唤醒）', () => {
  const now = 1_763_000_000_000
  const sevenHoursAgo = (now - 7 * 3600_000) / 1000
  const fresh = (now - 60_000) / 1000
  const r = selectBackfill(
    [
      { message_id: 11, time: sevenHoursAgo, user_id: 9, message: [{ type: 'text', data: { text: '很久以前的话' } }] },
      { message_id: 12, time: fresh, user_id: 9, message: [{ type: 'text', data: { text: '刚错过的话' } }] },
    ],
    { key: 'private:9', since: now - 8 * 3600_000, now, selfId: 1, config: { maxAgeMinutes: 360 } },
  )
  const byId = new Map(r.items.map((x) => [x.event.message_id, x]))
  assert.equal(byId.get(11).tooOld, true, '7 小时前的要标 tooOld')
  assert.equal(byId.get(12).tooOld, false, '1 分钟前的不算过旧')
})

test('backfillNoticeBlock：提示里带断线时长与最早一条的年龄，不暴露消息内容', () => {
  const s = backfillNoticeBlock({ gapMs: 3 * 3600_000, count: 2, earliestAgeMs: 40 * 60_000 })
  assert.match(s, /断开连接/)
  assert.match(s, /2 条消息/)
  assert.match(s, /40 分钟/)
  assert.doesNotMatch(s, /秘密|password/)
})

// ---------- 网关接线层（fake OneBot HTTP） ----------

let server, httpUrl, workDir
const hubCalls = []   // { event, opts }
const sentTexts = []  // { chatId, text }
const realtimeDispatched = []

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'backfill-lock-'))
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const action = req.url.replace(/^\//, '')
      res.setHeader('content-type', 'application/json')
      if (action === 'get_group_msg_history') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: historyFor('group') } }))
      } else if (action === 'get_friend_msg_history') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: historyFor('private') } }))
      } else {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  httpUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server?.close()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

// 私聊历史：覆盖 命令/审批/动态码/过旧/普通 五类。
// 时间基准必须取真实 Date.now()：gateway 的 selectBackfill 用真实时钟做窗口过滤，
// 固定常量时间戳会被当成「一年前」全部滤掉（M1-B 测试自纠错记录）。
const NOW = Date.now()
let historyFor = () => []
const privateHistory = () => [
  { message_id: 101, time: (NOW - 2 * 60_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '断线前的普通消息' } }] },
  { message_id: 102, time: (NOW - 2 * 60_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '/reset' } }] },
  { message_id: 103, time: (NOW - 2 * 60_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '123456' } }] },
  { message_id: 104, time: (NOW - 2 * 60_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '通过 10001' } }] },
  { message_id: 105, time: (NOW - 10 * 3600_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '十小时前的话' } }] },
]

function makeGateway(hubOverride, modularCore = null) {
  hubCalls.length = 0
  sentTexts.length = 0
  realtimeDispatched.length = 0
  // gateway.js 的 gapTracker 直接用 dataDir('upstream-seen.json')（env 在调用时读取），
  // 这里把数据目录指到临时目录，并预置一份「5 分钟没收到包」的游标，
  // 让第一个实时事件就能触发补收（每个用例独立重置，避免上一用例的 save 影响）。
  process.env.AURABOT_DATA_DIR = workDir
  writeFileSync(join(workDir, 'upstream-seen.json'), JSON.stringify({ lastPacketAt: Date.now() - 300_000 }))
  const cfg = {
    botQQ: '555',
    ownerQQ: '100',
    backfill: { enabled: true, gapMs: 60_000, settleMs: 10, maxAgeMinutes: 360, maxPerConversation: 50, lookbackMs: 60_000 },
    allow: { groups: [], private: ['100'] },
  }
  const gw = createGateway({
    getConfig: () => cfg,
    snowluma: { confirmLogin: async () => true },
    endpoint: () => ({ httpUrl, wsUrl: '', httpToken: '', wsToken: '' }),
    logger: { child: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    getHub: () => hubOverride || {
      onMessage: async (event, opts) => { hubCalls.push({ event, opts }) },
      sendText: async (chatId, text) => { sentTexts.push({ chatId, text }) },
    },
    getMods: () => null,
    getModularCore: () => modularCore,
    getDangerGuard: () => null,
    dispatch: (ev, kind) => { realtimeDispatched.push({ ev, kind }) },
  })
  return { gw, cfg }
}

/** 触发一次实时事件（带动 gap 判定 → 补收），等补收链走完。 */
async function pokeAndSettle(gw) {
  gw.handleEvent({ post_type: 'message', message_type: 'private', user_id: 100, message_id: 200, self_id: 555, time: NOW / 1000, message: [{ type: 'text', data: { text: 'hi' } }] })
  await new Promise((r) => setTimeout(r, 300))
}

test('接线：命令/审批/动态码/过旧零副作用，普通消息带 backfill 标记投递，迟到命令通知主人', async () => {
  historyFor = privateHistory
  const { gw } = makeGateway()
  await pokeAndSettle(gw)

  const delivered = hubCalls.map((x) => x.event.message_id)
  assert.deepEqual(delivered, [101], '只有普通新消息被投递（命令 102/103/104、过旧 105 都不进 hub）')
  assert.equal(hubCalls[0].opts?.backfill, true, '补收消息带 backfill 标记')
  assert.ok(hubCalls[0].opts?.earliestAgeMs !== undefined, '带最早消息年龄')

  const notice = sentTexts.find((s) => s.chatId === 'private:100')
  assert.ok(notice, '主人要有迟到命令提醒')
  assert.match(notice.text, /管理命令/)
  assert.match(notice.text, /「\/reset」/)
  assert.match(notice.text, /「通过 10001」/)
  assert.doesNotMatch(notice.text, /十小时前/, '过旧消息不属于「命令」提醒范畴')
})

test('接线：相同历史重复拉取不重复执行（第二遍零投递、提醒不重发）', async () => {
  historyFor = privateHistory
  const { gw } = makeGateway()
  // 第一遍的 since = gap.since（makeGateway 预置的 5 分钟前游标）
  const firstSince = Date.now() - 300_000
  await pokeAndSettle(gw)
  const firstCount = hubCalls.length
  assert.ok(firstCount >= 1, '第一遍至少投一条')

  // 直接再触发一次同样的拉取（同 since，模拟恢复后的再次补收）
  await gw.triggerBackfill({ since: firstSince, gapMs: 300_000 })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(hubCalls.length, firstCount, '第二遍不得重复投递')
  assert.equal(sentTexts.filter((s) => s.chatId === 'private:100').length, 1, '命令提醒也只发一次')
})

test('接线：断线期间实时消息与历史补收竞争——实时先处理，补收同 id 跳过（不重复）', async () => {
  historyFor = privateHistory
  const { gw } = makeGateway()
  // 拉取到的历史里包含 id 101；实时流里同一条先到
  gw.handleEvent({ post_type: 'message', message_type: 'private', user_id: 100, message_id: 101, self_id: 555, time: NOW / 1000, message: [{ type: 'text', data: { text: '断线前的普通消息' } }] })
  assert.equal(realtimeDispatched.length, 1, '实时路径照常派发')
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(hubCalls.map((x) => x.event.message_id), [], '补收侧看到同 id 必须跳过（不二次执行）')
})

test('接线：竞争——补收投递在飞（await 挂起）期间同 ID 实时事件到达，只处理一次', async () => {
  historyFor = privateHistory
  // 假 hub：onMessage 挂起直到手动放行，模拟「投递在飞、循环让出」
  let release
  const hang = new Promise((r) => { release = r })
  const hub = {
    onMessage: async (event, opts) => { hubCalls.push({ event, opts }); await hang },
    sendText: async (chatId, text) => { sentTexts.push({ chatId, text }) },
  }
  const { gw } = makeGateway(hub)
  // 用另一条消息（200）触发断档 → 补收开始，101 从历史里被投出并挂起在 onMessage
  gw.handleEvent({ post_type: 'message', message_type: 'private', user_id: 100, message_id: 200, self_id: 555, time: NOW / 1000, message: [{ type: 'text', data: { text: 'ping' } }] })
  for (let i = 0; i < 100 && !hubCalls.some((x) => x.event.message_id === 101); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(hubCalls.some((x) => x.event.message_id === 101), '补收 101 投递在飞（await 未返回）')
  // 同 ID 101 实时事件此刻到达：dispatch 前复查 seen，不得二次进处理链
  gw.handleEvent({ post_type: 'message', message_type: 'private', user_id: 100, message_id: 101, self_id: 555, time: NOW / 1000, message: [{ type: 'text', data: { text: '断线前的普通消息' } }] })
  assert.equal(realtimeDispatched.filter((x) => x.ev.message_id === 101).length, 0, '实时侧 seen 命中，跳过派发')
  release()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(hubCalls.filter((x) => x.event.message_id === 101).length, 1, '101 全链只被处理一次')
})

test('接线：过旧消息不主动唤醒（backfill.js 安全承诺 #3 的接线锁定）', async () => {
  historyFor = () => [
    { message_id: 301, time: (NOW - 10 * 3600_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '十小时前的话' } }] },
  ]
  const { gw } = makeGateway()
  await pokeAndSettle(gw)
  assert.deepEqual(hubCalls.map((x) => x.event.message_id), [], '过旧消息不得投给 hub 唤醒回复')
  assert.equal(sentTexts.length, 0, '过旧消息也不产生任何主动发送')
})

test('接线：有效普通消息不丢（多条按时间序全部投递，且带补收提示所需字段）', async () => {
  historyFor = () => [
    { message_id: 401, time: (NOW - 90_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '第一句' } }] },
    { message_id: 402, time: (NOW - 60_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '第二句' } }] },
    { message_id: 403, time: (NOW - 30_000) / 1000, user_id: 100, message: [{ type: 'text', data: { text: '第三句' } }] },
  ]
  const { gw } = makeGateway()
  await pokeAndSettle(gw)
  assert.deepEqual(hubCalls.map((x) => x.event.message_id), [401, 402, 403], '三条都投、按时间序')
})

test('gapTracker：断档超过阈值才触发，落盘恢复后仍记得上次时间', async () => {
  const file = join(workDir, 'gap-probe.json')
  let t = 1_000_000
  const tracker = createUpstreamGapTracker({ file, gapMs: 60_000, now: () => t, onError: (e) => { throw e } })
  assert.equal(tracker.notePacket(), null, '第一次没有 prev，不算断档')
  t += 30_000
  assert.equal(tracker.notePacket(), null, '30s 间隔小于阈值')
  t += 61_000
  const gap = tracker.notePacket()
  assert.ok(gap && gap.gapMs > 60_000, '61s 间隔判为断档')
  assert.equal(gap.since, 1_030_000, 'since 指向上一包时间')
  // 从盘上重建（模拟重启），lastPacketAt 恢复
  const t2 = 2_000_000
  const tracker2 = createUpstreamGapTracker({ file, gapMs: 60_000, now: () => t2 })
  assert.equal(tracker2.lastPacketAt(), t, '重启后游标从盘上恢复')
})


test('新核心补收：gateway 把真实断线时长和消息年龄一并传递', async () => {
  historyFor = privateHistory
  const calls = []
  const modularCore = { dispatchBackfill: async (event, meta) => { calls.push({ event, meta }) } }
  const { gw } = makeGateway(null, modularCore)
  const gapMs = 6 * 3600_000
  await gw.triggerBackfill({ since: NOW - 300_000, gapMs })
  const call = calls.find((x) => x.event.message_id === 101)
  assert.ok(call, '普通补收消息应进入新核心')
  assert.equal(call.meta?.gapMs, gapMs)
  assert.ok(call.meta?.earliestAgeMs > 0)
})
