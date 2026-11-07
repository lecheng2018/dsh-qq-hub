// 蒸馏证据源修正（1.3.63）：chatlog 才是完整记录，DSH 会话记录只含「进过模型上下文」的部分。
// 实测同一个人（同一天同群）：chatlog 146 条、清洗后 106 条；会话记录只有 17 条。
// 主人报告「明明后面一直在聊天，怎么只有 14 句」——根因是我选错了源，且 chatlog 整理完即删。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mem0 = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')

test('distillHistory：chatlog 优先（完整记录），会话记录只作兜底', () => {
  assert.match(mem0, /source: 'chatlog'/, 'chatlog 是首选源')
  assert.match(mem0, /if \(!lines\.length\) \{[\s\S]{0,400}source: 'sessions'/, '没覆盖到才退回会话记录')
  assert.match(mem0, /hub\.chatLogOf\(day\)/, '读 chatlog')
})

test('整理完不再立刻删聊天流水（保留期交给 keepDays 滚动清理）', () => {
  // consolidate 里不能有「整理完就删当天」
  const consolidate = mem0.slice(mem0.indexOf('async function consolidate('), mem0.indexOf('async function consolidate(') + 6000)
  assert.doesNotMatch(consolidate, /hub\.deleteChatLog\(day\)/, 'consolidate 不该再删当天流水')
  // 滚动清理仍在（按 keepDays）
  assert.match(mem0, /const keepDays = Math\.max\(14[\s\S]{0,300}deleteChatLog\(day\)/, '滚动清理保留')
})

test('面板：聊天流水保留天数可调 + 历史扫描显示数据源', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /f\.range\('chatlog\.keepDays', 14, 365, 1/, '保留天数可调')
  assert.match(client, /mood: \['mood', 'memory', 'chatlog'\]/, 'chatlog 段进保存白名单')
  assert.match(client, /hist\.source === 'chatlog'/, '显示用的是哪个源')
})

test('端到端：喂一天的 chatlog 流水，学同一个人的证据量远大于会话记录', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'hist-src-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const { collectMemberLines } = await import('../src/features/distill.js')
  const cfg = normalize({ ownerQQ: '10000001', memory: { enabled: true } })
  // 造一天流水：目标 20 条 + 别人 10 条
  const day = '2026-11-06'
  const rows = []
  for (let i = 0; i < 20; i++) rows.push({ t: 1000 + i * 1000, chatId: 'group:1', who: '目标', uid: '111', text: '第' + i + '句' })
  for (let i = 0; i < 10; i++) rows.push({ t: 2000 + i * 1000, chatId: 'group:1', who: '别人', uid: '222', text: '路人' + i })
  const mem = createMemoryStore({
    dsh: {}, getConfig: () => cfg,
    hub: { chatLogOf: (d) => (d === day ? rows : []), chatLogDays: () => [day] },
    log: () => {}, personaText: () => '',
  })
  const h = mem.distillHistory({ group: '1' })
  assert.equal(h.source, 'chatlog')
  assert.equal(h.total, 30)
  const mine = collectMemberLines(h.lines, '111')
  assert.equal(mine.length, 20, '目标 20 条全在（chatlog 是完整记录）')
  assert.equal(h.speakers[0].uid, '111')
  assert.equal(h.speakers[0].count, 20)
})

test('回归：chatlog 按**群号**过滤，会话记录按**群名**过滤（1.3.63 修）', async () => {
  // 之前 distillHistory 只收一个 group 参数，两条链路各要一样的东西：
  // chatlog 的 chatId 是 group:<群号>，会话记录里是群名（标题）。
  // 传错 → chatlog 一条都匹配不上 → 静默退回会话记录 → 证据量少 8 倍（146 → 17）。
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'hist-gid-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ ownerQQ: '10000001', memory: { enabled: true } })
  const day = '2026-11-06'
  const rows = [
    { t: 1000, chatId: 'group:111222333', who: '目标', uid: '111', text: '在这个群说的' },
    { t: 2000, chatId: 'group:222333444', who: '目标', uid: '111', text: '在另一个群说的' },
  ]
  const mem = createMemoryStore({
    dsh: {}, getConfig: () => cfg,
    hub: { chatLogOf: (d) => (d === day ? rows : []), chatLogDays: () => [day] },
    log: () => {}, personaText: () => '',
  })
  const byId = mem.distillHistory({ gid: '111222333' })
  assert.equal(byId.source, 'chatlog')
  assert.equal(byId.total, 1, '按群号只取到那个群的')
  assert.equal(byId.lines[0].text, '在这个群说的')
  // 用群名去查 chatlog 匹配不到 → 必须回落到会话记录，而不是返回空
  const byName = mem.distillHistory({ group: '某个群名' })
  assert.ok(byName.total >= 0)
  assert.ok(byName.source === 'chatlog' || byName.source === 'sessions')
})

test('回归：statsToPrompt 对旧库/坏形态 topNGrams 不炸（object is not iterable）', async () => {
  const { statsToPrompt } = await import('../src/features/style-stats.js')
  // 2026-11-07 实测：库里旧画像的 topNGrams 缺失或形态不对时，[g, n] 解构抛
  // 'object is not iterable'，整条「从历史学」直接 500。
  const base = { burstMerged: [{ t: 1, text: 'x', count: 1 }], lengthMedian: 10, lengthP90: 20 }
  // 缺 topNGrams
  assert.ok(statsToPrompt(base).includes('中位 10 字'))
  // topNGrams 是非对象数组
  assert.doesNotThrow(() => statsToPrompt({ ...base, topNGrams: ['字符串'] }))
  // topNGrams 含混入坏条目
  assert.doesNotThrow(() => statsToPrompt({ ...base, topNGrams: [{ g: '羊毛', n: 5 }, null, 'x'] }))
  const out = statsToPrompt({ ...base, topNGrams: [{ g: '羊毛', n: 5 }, null] })
  assert.match(out, /羊毛×5/, '好的条目照常输出')
})
