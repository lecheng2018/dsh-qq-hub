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
      if (system.includes('整理长期记忆')) out = text.includes('看海') ? '[{"text":"阿花周末去看海了","about":"阿花","about_qq":"30000003","importance":0.5}]' : text.includes('辣') ? '[{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]' : '[]'
      else if (system.includes('{"insights"')) out = '{"insights":["他喜欢被吐槽"],"style":["消息很短，常一句话分几条发","爱用 hhh"]}'
      else if (system.includes('自然会被带上')) out = '["偶尔用 hhh"]'
      else if (system.includes('旧档案')) out = '[{"text":"阿强喜欢钓鱼","about":"阿强","importance":0.7},{"text":"阿花周末去看海了","about":"阿花"}]'
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  },
}

const logs = new Map() // day → lines
const hubState = { text: '', speakers: [] }
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => hubState.text,
  speakersOf: () => hubState.speakers,
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

test('检索：同时偏向好几个说话人（群里这一段谁在说）', async () => {
  const { buildIndex, search } = await import('../src/features/memory.js')
  const idx = buildIndex([
    { id: 'a', text: '阿花养了一只猫', about: '30000003', importance: 0.5, at: Date.now() },
    { id: 'b', text: '小明在学吉他', about: '30000004', importance: 0.5, at: Date.now() },
    { id: 'c', text: '天气预报说要下雨', about: '', importance: 0.5, at: Date.now() },
  ])
  const ids = search(idx, '今天干嘛呢', { about: ['30000003', '30000004'] }).map((h) => h.it.id).sort()
  assert.deepEqual(ids, ['a', 'b'])
})

test('经历：她做过的事常驻上下文；群里优先想起正在说话的人', () => {
  mem.addEvent({ text: '给主人唱了《小幸运》', about: '10000001', tags: ['唱歌'] })
  assert.equal(mem.recentEvents()[0].text, '给主人唱了《小幸运》')
  const ctx = mem.contextFor({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, 's1')
  assert.match(ctx, /你最近做过的事：刚才给主人唱了《小幸运》/)
  mem.add({ text: '阿花最近在减肥', about: '30000003', aboutName: '阿花', importance: 0.6, source: 'tool' })
  hubState.text = '今天吃什么'
  hubState.speakers = ['30000003']
  const g = mem.contextFor({ kind: 'group', groupId: '555', chatId: 'group:555' }, 's2')
  assert.match(g, /阿花最近在减肥/)
  assert.doesNotMatch(g.split('你记得这些事')[1] || '', /小幸运/, '最近经历已经列过的不重复')
  hubState.text = ''
  hubState.speakers = []
})

test('整理：群聊和空间里的事按 QQ 号记到人头上；空间动态一条也提炼', async () => {
  const today = day(new Date())
  logs.set(today, [...(logs.get(today) || []), { chatId: 'qzone', who: '阿花', uid: '30000003', text: '发了说说：周末去看海了' }])
  const n = asked.length
  await mem.consolidate({ includeToday: true })
  const qz = asked.slice(n).find((a) => a.system.includes('QQ 空间里的动态'))
  assert.ok(qz && qz.text.includes('阿花(30000003)'), '空间流水带着 QQ 号交给模型')
  assert.ok(!asked.slice(n).some((a) => a.system.includes('{"insights"') && a.text.includes('看海')), '空间不回顾相处经验')
  const hit = mem.list('看海')[0]
  assert.equal(hit.about, '30000003')
})

test('遗忘：不重要、两个月没想起过的自动记忆忘掉，自己记的和经历不忘', async () => {
  const { shouldForget } = await import('../src/features/memory.js')
  const old = Date.now() - 90 * 86400_000
  assert.equal(shouldForget({ source: 'auto', importance: 0.4, at: old }), true)
  assert.equal(shouldForget({ source: 'auto', importance: 0.4, at: old, lastHit: Date.now() }), false, '最近被想起过')
  assert.equal(shouldForget({ source: 'auto', importance: 0.8, at: old }), false, '重要的不忘')
  assert.equal(shouldForget({ source: 'tool', importance: 0.3, at: old }), false)
  assert.equal(shouldForget({ source: 'event', importance: 0.3, at: old }), false)
})

test('想起来的记忆带时间；最近想起了什么有记录（含想不起来的那次）', async () => {
  const { whenText } = await import('../src/features/memory.js')
  const now = new Date(2026, 9, 25, 12).getTime()
  assert.equal(whenText(now, now), '今天')
  assert.equal(whenText(now - 86400_000, now), '昨天')
  assert.equal(whenText(now - 3 * 86400_000, now), '3 天前')
  assert.equal(whenText(now - 400 * 86400_000, now).startsWith('去年'), true)
  hubState.text = '阿花最近怎么样'
  const ctx = mem.contextFor({ kind: 'private', userId: '30000003', chatId: 'private:30000003' }, 's3')
  assert.ok(ctx.includes('[今天] [阿花] 阿花'), ctx)
  const log = mem.recalls()[0]
  assert.equal(log.where, 'private:30000003')
  assert.ok(log.hits.length && log.hits[0].why.length)
  hubState.text = '完全无关的量子力学'
  mem.contextFor({ kind: 'group', groupId: '9', chatId: 'group:9' }, 's4')
  assert.equal(mem.recalls()[0].hits.length, 0)
  hubState.text = ''
})

test('导入旧档案：挑出候选、去掉已经记过的，勾选后存进去', async () => {
  const c = await mem.importCandidates('一大段旧档案：阿强喜欢钓鱼。阿花周末去看海了。')
  assert.deepEqual(c.map((x) => x.text), ['阿强喜欢钓鱼'], '阿花看海已经记过，去掉')
  assert.equal(mem.importCommit(c), 1)
  assert.equal(mem.list('钓鱼')[0].source, 'import')
})
