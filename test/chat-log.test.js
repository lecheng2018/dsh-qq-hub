import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLog, createChatLogApi } from '../src/chat/chat-log.js'

const dayOf = (time) => {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-log-test-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const service = createChatLog({ getConfig: () => ({ ownerQQ: '10001', ownerName: '主人', chatlog: { keepDays: 14 } }), ...options })
  t.after(() => {
    service.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, service }
}

test('chat log: append/read/list uses shared JSONL and preserves the legacy record shape', (t) => {
  const now = new Date(2026, 10, 12, 12).getTime()
  const { service } = fixture(t, { now: () => now })
  service.append('private:10001', '', '原始聊天', '10001')
  const day = dayOf(now)
  assert.deepEqual(service.listDays(), [day])
  assert.deepEqual(service.readDay(day), [{ t: now, chatId: 'private:10001', who: '主人', uid: '10001', text: '原始聊天' }])
  assert.deepEqual(service.readDaySnapshot(day).records, service.readDay(day))
})

test('chat log: consumed-prefix fingerprints remain stable on append and detect replacement', (t) => {
  const now = new Date(2026, 10, 12, 12).getTime()
  const { service } = fixture(t, { now: () => now })
  service.append('group:20001', '小明', '第一条')
  const day = dayOf(now)
  const first = service.readDaySnapshot(day)
  service.append('group:20001', '小明', '第二条')
  const appended = service.readDaySnapshot(day)
  assert.equal(appended.prefixFingerprint(1), first.prefixFingerprint(1))
  assert.notEqual(appended.prefixFingerprint(2), first.prefixFingerprint(1))

  const file = join(process.env.DSH_QQ_HUB_DATA_DIR, 'chatlog', `${day}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ t: now, chatId: 'group:20001', who: '小明', text: '替换的一条' }),
    JSON.stringify({ t: now, chatId: 'group:20001', who: '小明', text: '第二条' }),
  ].join('\n') + '\n')
  const replaced = service.readDaySnapshot(day)
  assert.notEqual(replaced.prefixFingerprint(1), first.prefixFingerprint(1))
})

test('chat log: malformed JSONL fails with a line-specific error instead of appearing empty', (t) => {
  const now = new Date(2026, 10, 12, 12).getTime()
  const { service } = fixture(t, { now: () => now })
  const day = dayOf(now)
  const dir = join(process.env.DSH_QQ_HUB_DATA_DIR, 'chatlog')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.jsonl`), '\n{bad json}\n')
  assert.throws(() => service.readDay(day), new RegExp(`${day}.*行 2`))
})

test('consumer API only exposes append and read capabilities, not retention controls', (t) => {
  const { service } = fixture(t)
  const api = createChatLogApi(service)
  assert.deepEqual(Object.keys(api).sort(), ['append', 'listDays', 'readDay', 'readDaySnapshot'])
  assert.equal(api.pruneBefore, undefined)
  assert.equal(api.dispose, undefined)
  api.append('private:10001', '主人', '只读模块可追加')
  assert.equal(api.readDay(api.listDays()[0])[0].text, '只读模块可追加')
})

test('chat log: pruning only removes valid dated files older than the cutoff', (t) => {
  const { service } = fixture(t)
  const dir = join(process.env.DSH_QQ_HUB_DATA_DIR, 'chatlog')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-10-01.jsonl'), '')
  writeFileSync(join(dir, '2026-11-01.jsonl'), '')
  writeFileSync(join(dir, 'notes.jsonl'), '')
  assert.deepEqual(service.pruneBefore('2026-11-01'), ['2026-10-01'])
  assert.deepEqual(service.listDays(), ['2026-11-01'])
})

test('retention belongs to the service and releases its timer on stop/restart', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = new Date(2026, 10, 12, 12).getTime()
  const { service } = fixture(t, { now: () => now, log: { info() {}, warn() {} } })
  const stop = service.startRetention()
  assert.equal(service.startRetention(), stop, '重复装配不能创建孤儿 interval')
  service.append('group:1', '甲', '原始记录')
  now += 15 * 86400_000
  t.mock.timers.tick(3600_000)
  assert.deepEqual(service.listDays(), [], '不需要 memory.tick 也会清理过期流水')
  stop()
  service.append('group:1', '甲', '停止后的记录')
  now += 15 * 86400_000
  t.mock.timers.tick(3600_000)
  assert.equal(service.listDays().length, 1, '停止后原任务不能继续清理')
  service.startRetention()
  assert.deepEqual(service.listDays(), [], '重新装配会恢复唯一保留任务')
})
