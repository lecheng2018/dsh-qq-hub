import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCommandLike,
  createSeenMessageIds,
  createUpstreamGapTracker,
  selectBackfill,
  describeDuration,
  backfillNoticeBlock
} from '../src/chat/backfill.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

// 跨平台临时文件：原先硬编码 E:/work/... 会在 Linux/macOS 上把「E:」当成字面目录名，
// 在仓库里递归建出空壳 E:/work/dsh-aurabot-qq/test，污染工作区与打包产物。
const tmpUpstreamFile = () => join(tmpdir(), `aurabot-test-upstream-${process.pid}-${Date.now()}.json`)

test('isCommandLike: 识别命令/动态码/审批指令，不误判普通聊天', () => {
  // 斜杠命令
  assert.equal(isCommandLike('/help'), true)
  assert.equal(isCommandLike('/unlock 123456'), true)
  assert.equal(isCommandLike('／status'), true)

  // TOTP 动态口令
  assert.equal(isCommandLike('123456'), true)
  assert.equal(isCommandLike('88888888'), true)

  // 审批指令
  assert.equal(isCommandLike('通过 #1'), true)
  assert.equal(isCommandLike('同意'), true)
  assert.equal(isCommandLike('拒绝 2'), true)
  assert.equal(isCommandLike('pass'), true)
  assert.equal(isCommandLike('deny'), true)

  // 普通聊天
  assert.equal(isCommandLike('你好呀'), false)
  assert.equal(isCommandLike('通过率是多少？'), false)
  assert.equal(isCommandLike('今天天气不错'), false)
  assert.equal(isCommandLike('123不是验证码'), false)
})

test('createSeenMessageIds: 消息去重与容量上限', () => {
  const seen = createSeenMessageIds({ max: 3 })
  seen.add('group:1', '101')
  seen.add('group:1', '102')
  seen.add('group:1', '103')

  assert.equal(seen.has('group:1', '101'), true)
  assert.equal(seen.has('group:1', '104'), false)

  // 超过 max=3，淘汰最早的 101
  seen.add('group:1', '104')
  assert.equal(seen.has('group:1', '101'), false)
  assert.equal(seen.has('group:1', '104'), true)
})

test('createUpstreamGapTracker: 断档检测', () => {
  let currentTime = 1000_000
  const tracker = createUpstreamGapTracker({
    file: tmpUpstreamFile(),
    gapMs: 120_000,
    now: () => currentTime
  })

  // 第一次记录
  assert.equal(tracker.notePacket(), null)

  // 正常间隔 30 秒（没有断档）
  currentTime += 30_000
  assert.equal(tracker.notePacket(), null)

  // 异常间隔 3 分钟（发生断档）
  currentTime += 180_000
  const gap = tracker.notePacket()
  assert.ok(gap)
  assert.equal(gap.gapMs, 180_000)
  assert.equal(gap.since, 1030_000)

  // 清理临时文件
  try { unlinkSync(tracker.file || tmpUpstreamFile()) } catch {}
})

test('selectBackfill: 从历史中筛选、去重与命令隔离', () => {
  const now = 2000_000
  const since = 1800_000 // 200秒前断线
  const selfId = '99999'
  const seen = createSeenMessageIds()
  seen.add('group:1', '201') // 已经处理过的一条

  const messages = [
    // 已经处理过的消息
    { message_id: '201', user_id: '1001', time: 1850, message: [{ type: 'text', data: { text: '旧消息' } }] },
    // 机器人自己发的消息（过滤）
    { message_id: '202', user_id: '99999', time: 1860, message: [{ type: 'text', data: { text: '我是机器人' } }] },
    // 补收的普通用户消息（应保留）
    { message_id: '203', user_id: '1002', time: 1870, message: [{ type: 'text', data: { text: '服务器挂了' } }] },
    // 补收的命令消息（应隔离进 skippedCommands）
    { message_id: '204', user_id: '1001', time: 1880, message: [{ type: 'text', data: { text: '/restart' } }] },
    // 另一条普通消息（应保留）
    { message_id: '205', user_id: '1003', time: 1890, message: [{ type: 'text', data: { text: '加一' } }] },
  ]

  const result = selectBackfill(messages, {
    key: 'group:1',
    since,
    now,
    selfId,
    seen,
    config: { maxPerConversation: 10 }
  })

  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].event.message_id, '203')
  assert.equal(result.items[1].event.message_id, '205')

  assert.equal(result.skippedCommands.length, 1)
  assert.equal(result.skippedCommands[0].event.message_id, '204')
  assert.equal(result.skippedCommands[0].text, '/restart')
})

test('describeDuration & notice block', () => {
  assert.equal(describeDuration(60_000), '约 1 分钟')
  assert.equal(describeDuration(125_000), '约 2 分钟')
  assert.equal(describeDuration(3600_000), '约 1 小时')
  assert.equal(describeDuration(3900_000), '约 1 小时 5 分')

  const notice = backfillNoticeBlock({ gapMs: 180_000, count: 3, earliestAgeMs: 150_000 })
  assert.match(notice, /断开连接约 3 分钟/)
  assert.match(notice, /3 条消息是断线期间错过的/)
})
