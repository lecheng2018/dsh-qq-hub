// 记忆整理：一天两次、增量处理不重复、学说话方式。用假的模型和假的聊天流水。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
const asked = []

// 假模型：按系统提示词判断是哪种请求
const dsh = {
  get: () => null,
  llm: {
    async *stream({ system, messages }) {
      const text = messages[0].content[0].text
      asked.push({ system, text })
      let out = '[]'
      if (system.includes('整理长期记忆')) out = text.includes('辣') ? '[{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]' : '[]'
      else if (system.includes('{"insights"')) out = '{"insights":["他喜欢被吐槽"],"style":["消息很短，常一句话分几条发","爱用 hhh"]}'
      else if (system.includes('自然会被带上')) out = '["偶尔用 hhh"]'
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  },
}

const logs = new Map() // day → lines
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => '',
}
const line = (text, who = '小明') => ({ chatId: 'private:10000001', who, text })
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let cfg
let mem

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-mem-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ model: { provider: 'p', model: 'm' } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } })
})

test('默认一天整理两次；老配置的单个时间自动变成两个', () => {
  assert.deepEqual(normalize({}).memory.consolidateTimes, ['04:00', '16:00'])
  assert.deepEqual(normalize({ memory: { consolidateAt: '03:30' } }).memory.consolidateTimes, ['03:30', '15:30'])
})

test('整理：提炼记忆、相处经验和说话方式；同一天再整理只处理新增的聊天', async () => {
  const today = day(new Date())
  logs.set(today, [line('我超爱吃辣'), line('hhh'), line('今天好累'), line('嗯嗯', 'bot')])
  let r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.added, 1)
  assert.equal(mem.insights()[0].list[0].text, '他喜欢被吐槽')
  assert.deepEqual(mem.styles()['qq:10000001'], ['消息很短，常一句话分几条发', '爱用 hhh'])
  assert.ok(logs.has(today), '今天的流水留着（写日记要用）')

  // 下午再整理：前面那 4 行不会再交给模型
  const n = asked.filter((a) => a.system.includes('整理长期记忆')).length
  r = await mem.consolidate({ includeToday: true })
  assert.equal(asked.filter((a) => a.system.includes('整理长期记忆')).length, n, '没有新聊天就不再提炼')

  logs.get(today).push(line('周末去爬山'), line('你去不去'), line('hhh 来嘛'))
  await mem.consolidate({ includeToday: true })
  const last = asked.filter((a) => a.system.includes('整理长期记忆')).at(-1)
  assert.ok(last.text.includes('爬山') && !last.text.includes('爱吃辣'), '只处理新的那几行')
})

test('说话方式会进到聊天上下文里', () => {
  const ctx = mem.contextFor({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, 's1')
  assert.match(ctx, /说话方式/)
  assert.match(ctx, /hhh/)
  assert.match(ctx, /别刻意模仿/)
})

test('过了一天的流水整理完删掉', async () => {
  const y = new Date(Date.now() - 86400000)
  logs.set(day(y), [line('昨天吃了火锅 好辣'), line('哈哈'), line('晚安')])
  await mem.consolidate({ includeToday: false })
  assert.equal(logs.has(day(y)), false)
})
