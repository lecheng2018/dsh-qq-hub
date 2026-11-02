import test from 'node:test'
import assert from 'node:assert/strict'
import { nextOccurrence, parseCron } from '../src/modules/scheduler/schedule.js'
import { parseRemindCommand } from '../src/modules/scheduler/commands.js'
import { createSchedulerEngine } from '../src/modules/scheduler/engine.js'
import { zonedParts, zonedToUtc } from '../src/modules/scheduler/time.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

// 跨平台临时文件：原先硬编码 E:/work/... 会在 Linux/macOS 上把「E:」当成字面目录名
// 在仓库里递归建出空壳 E:/work/dsh-aurabot-qq/test，污染工作区与打包产物。
const tmpSchedulerFile = () => join(tmpdir(), `aurabot-test-scheduler-${process.pid}-${Date.now()}.json`)

test('schedule: once 一次性任务计算', () => {
  const tz = 'Asia/Shanghai'
  const afterMs = zonedToUtc({ year: 2026, month: 11, day: 2, hour: 10, minute: 0, second: 0 }, tz)

  // 未来的时刻
  const next = nextOccurrence({ type: 'once', date: '2026-11-02', time: '11:30' }, afterMs, { tz })
  assert.ok(next)
  const p = zonedParts(next, tz)
  assert.equal(p.hour, 11)
  assert.equal(p.minute, 30)

  // 过去的时刻返回 null
  const past = nextOccurrence({ type: 'once', date: '2026-11-02', time: '09:00' }, afterMs, { tz })
  assert.equal(past, null)
})

test('schedule: daily 与 workdays 计算', () => {
  const tz = 'Asia/Shanghai'
  // 设当前为周五 10:00 (2026-11-06 周五)
  const fridayMs = zonedToUtc({ year: 2026, month: 11, day: 6, hour: 10, minute: 0, second: 0 }, tz)

  // daily 当天 15:00
  const dailySameDay = nextOccurrence({ type: 'daily', times: ['15:00'] }, fridayMs, { tz })
  assert.equal(zonedParts(dailySameDay, tz).day, 6)

  // workdays 当天 09:00 已过，下一个应该跨过周六周日，直接到下周一 11-09 09:00
  const nextWorkday = nextOccurrence({ type: 'workdays', times: ['09:00'] }, fridayMs, { tz })
  assert.ok(nextWorkday)
  const p = zonedParts(nextWorkday, tz)
  assert.equal(p.day, 9) // 周一
  assert.equal(p.hour, 9)
  assert.equal(p.minute, 0)
})

test('schedule: interval 相对间隔', () => {
  const afterMs = 1000_000
  const next = nextOccurrence({ type: 'interval', everyMinutes: 10 }, afterMs)
  assert.equal(next, 1200_000)
})

test('commands: /remind 指令解析', () => {
  const now = zonedToUtc({ year: 2026, month: 11, day: 2, hour: 12, minute: 0, second: 0 })

  // 相对时间 in 30m
  const c1 = parseRemindCommand('/remind in 30m 喝水', { now })
  assert.equal(c1.action, 'add')
  assert.equal(c1.task.text, '喝水')
  assert.equal(c1.task.schedule.time, '12:30')

  // 指定时刻 once
  const c2 = parseRemindCommand('/remind once 2026-11-05 09:00 汇报任务')
  assert.equal(c2.action, 'add')
  assert.equal(c2.task.text, '汇报任务')
  assert.equal(c2.task.schedule.date, '2026-11-05')
  assert.equal(c2.task.schedule.time, '09:00')

  // 列表与删除
  assert.deepEqual(parseRemindCommand('/remind list'), { action: 'list' })
  assert.deepEqual(parseRemindCommand('/remind del 2'), { action: 'delete', id: 2 })
  assert.deepEqual(parseRemindCommand('/remind on 3'), { action: 'on', id: 3 })
})

test('createSchedulerEngine: 增删改与到期触发', async () => {
  let currentTime = 1000_000
  const executed = []

  const engine = createSchedulerEngine({
    tz: 'Asia/Shanghai',
    file: tmpSchedulerFile()
  })

  // 添加一个 10秒后到期的任务
  const task = engine.add({
    text: '测试提醒',
    target: 'owner',
    schedule: { type: 'interval', everyMinutes: 1 },
  })
  assert.equal(engine.count(), 1)

  // 推进时间触发
  await engine.tick(task.nextRunAt + 1000, async (t) => {
    executed.push(t.id)
  })

  assert.equal(executed.length, 1)
  assert.equal(executed[0], task.id)

  // 删除任务
  assert.equal(engine.remove(task.id), true)
  assert.equal(engine.count(), 0)

  try { unlinkSync(engine.file || tmpSchedulerFile()) } catch {}
})
