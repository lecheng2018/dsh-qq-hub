// 轮原子性（2026-11-12）：一条回复拆成多条气泡时，本轮气泡必须连续发完，
// 其他写者（定时任务 / 模块直发 / 联动接口）排到本轮之后，绝不插进气泡中间。
//
// 改前的两个缺陷（本次钉住）：
//   1. 轮内每条气泡的 request 都把自己的链写回 chains，把 reserve() 建的那道闸覆盖掉
//      —— 只有在「第一个气泡入队之前」来的写者会排队，之后的直接挂在气泡后面；
//   2. 每条气泡都锚在 reserve 时刻的 previous 快照上（而不是当前链尾），
//      于是它跟轮内新入队的写者互不排队 —— 实测同聊天两条物理发送同时在飞。
//
// 语义选择（已拍板）：轮原子性优先。期望顺序 A1 → A2 → B，而不是入队顺序 A1 → B → A2。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createOutbox } from '../src/chat/outbox.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const segs = (text) => [{ type: 'text', data: { text } }]

/** 记录「在飞区间」的网关：start/end 事件按真实时序落进 events。 */
function tracingGateway(events, delayMs = 30) {
  let n = 0
  return {
    async send(action, params) {
      const tag = params.message[0].data.text
      events.push(`start:${tag}`)
      await sleep(delayMs)
      events.push(`end:${tag}`)
      n += 1
      return { messageId: `gw-${n}` }
    },
  }
}

function makeOutbox() {
  const events = []
  const outbox = createOutbox({
    send: tracingGateway(events).send,
    enabled: () => true,
    dryRun: () => false,
  })
  const send = (tag, ticket) => outbox.request({
    chatKey: 'private:1',
    segments: segs(tag),
    ...(ticket ? { _outboxTicket: ticket } : {}),
  })
  return { events, outbox, send }
}

test('轮内气泡连续：A1 → A2 → B，别的写者不插进两段之间', async () => {
  const { events, outbox, send } = makeOutbox()
  const r = outbox.reserve('private:1')

  await send('A1', r.ticket)          // 第 1 条气泡（真实投递循环逐条 await）
  const b = send('B')                 // 轮内另一写者入队（首气泡之后）
  await send('A2', r.ticket)          // 第 2 条气泡
  r.release()                         // deliver() 的 finally
  await b

  assert.deepEqual(events, ['start:A1', 'end:A1', 'start:A2', 'end:A2', 'start:B', 'end:B'],
    '本轮气泡必须连续；其他写者排在本轮之后')
})

test('提前 release 也插不进来：开闸要等本轮最后一条气泡落地', async () => {
  const { events, outbox, send } = makeOutbox()
  const r = outbox.reserve('private:1')

  const a1 = send('A1', r.ticket)
  const a2 = send('A2', r.ticket)
  const b = send('B')
  r.release()                         // 比真实链路更苛刻：立刻放闸
  await Promise.all([a1, a2, b])

  assert.deepEqual(events, ['start:A1', 'end:A1', 'start:A2', 'end:A2', 'start:B', 'end:B'],
    'release 早于气泡结束，B 仍须等最后一条气泡')
})

test('两轮重叠：后一轮的气泡等前一轮 release', async () => {
  const { events, outbox, send } = makeOutbox()
  const r1 = outbox.reserve('private:1')
  const t1 = send('T1', r1.ticket)
  const r2 = outbox.reserve('private:1')   // 第一轮还没发完就来了第二轮
  const t2 = send('T2', r2.ticket)

  await t1
  r1.release()
  r2.release()
  await t2

  assert.deepEqual(events, ['start:T1', 'end:T1', 'start:T2', 'end:T2'], '两轮不许交错')
})

test('本轮结束后不留死闸：下一个请求照常立刻发', async () => {
  const { events, outbox, send } = makeOutbox()
  const r = outbox.reserve('private:1')
  await send('A1', r.ticket)
  r.release()
  await sleep(10)                     // 让 gate 链的 cleanup 落定
  await send('C')

  assert.deepEqual(events, ['start:A1', 'end:A1', 'start:C', 'end:C'], '闸不能挂住后续请求')
})

test('无票请求之间仍然严格 FIFO（原有语义不回退）', async () => {
  const { events, send } = makeOutbox()
  await Promise.all([send('X'), send('Y'), send('Z')])
  assert.deepEqual(events, ['start:X', 'end:X', 'start:Y', 'end:Y', 'start:Z', 'end:Z'],
    '同聊天无票请求按入队顺序串行')
})

// 轮内上传必须并入本轮链尾：hub 的文件/图片/语音上传走的是 egress.deliver，
// 若不带票就会挂在「本轮闸」上，而本轮正 await 它 —— 自己等自己的死锁
// （2026-11-12 实测：带上票之前，发文件/换头像/生图等 e2e 全部 30 秒超时）。
test('legacy 上传路径带上本轮的票（防轮内自锁）', () => {
  const hub = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
  const at = hub.indexOf('const callFile = egressRef?.current')
  assert.ok(at > 0, '找不到上传出口')
  assert.match(hub.slice(at, at + 420), /_outboxTicket: deliveryContext\.getStore\(\)\?\.ticket/,
    '上传请求必须带票；否则轮内上传会等本轮闸 → 死锁')
})

// 轮内票自动继承：上传 / 戳一戳 / 嵌套 deliver 这些路径不用逐个手动传票，
// 否则漏一个就「轮内请求等本轮闸」→ 自锁（2026-11-12 实测：发文件、换头像、生图、戳一戳全挂）。
test('轮内请求自动继承本轮票：上传排在本轮气泡之后，不并发', async () => {
  const events = []
  let ticket = null
  const outbox = createOutbox({
    send: async (action, params) => {
      const tag = params.message?.[0]?.data?.text || params.file || action
      events.push(`start:${tag}`)
      await sleep(30)
      events.push(`end:${tag}`)
      return { messageId: `gw-${tag}` }
    },
    enabled: () => true,
    dryRun: () => false,
    currentTicket: () => ticket,
  })
  const r = outbox.reserve('private:1')
  ticket = r.ticket

  const bubble = outbox.request({ chatKey: 'private:1', segments: segs('A1') })
  const upload = outbox.request({ chatKey: 'private:1', action: 'upload_private_file', params: { user_id: 1, file: 'v.wav' }, receipt: 'optional' })
  await Promise.all([bubble, upload])
  r.release()

  assert.deepEqual(events, ['start:A1', 'end:A1', 'start:v.wav', 'end:v.wav'],
    '上传要排在本轮气泡之后（串行），不能并发也不能挂到闸上')
})

test('票按聊天隔离：轮内给别的聊天发消息不会误用本轮票', async () => {
  const events = []
  let ticket = null
  const outbox = createOutbox({
    send: async (action, params) => {
      const tag = params.message?.[0]?.data?.text || action
      events.push(`start:${tag}`)
      await sleep(40)
      events.push(`end:${tag}`)
      return { messageId: `gw-${tag}` }
    },
    enabled: () => true,
    dryRun: () => false,
    currentTicket: () => ticket,
  })
  const r = outbox.reserve('private:1')
  ticket = r.ticket

  const mine = outbox.request({ chatKey: 'private:1', segments: segs('A1') })
  const other = outbox.request({ chatKey: 'private:2', segments: segs('O') })  // 另一个聊天
  await Promise.all([mine, other])
  r.release()

  assert.ok(events.indexOf('start:O') < events.indexOf('end:A1'),
    '别的聊天不该被本轮的票串住（票是按聊天的）')
})
