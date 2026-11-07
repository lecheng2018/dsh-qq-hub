// 群黑话本独立存储与面板（1.3.58）。
// 背景：1.3.53 把黑话写进 insights[key]，和相处经验共用 8 条槽位；
// reflect() 每轮整理会整体覆盖那个数组，模型不知道【黑话】条目存在 → 学到的黑话下一轮就没了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

async function freshStore(cfgOver = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'slangbook-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ ownerQQ: '10000001', memory: { enabled: true, slang: true }, ...cfgOver })
  return createMemoryStore({ dsh: {}, getConfig: () => cfg, hub: {}, log: () => {}, personaText: () => '' })
}

test('黑话独立存储：写入/读取/同词更新，不和 insights 抢槽位', async () => {
  const mem = await freshStore()
  mem.putSlang('123', [{ word: '面包片', meaning: '平民配装' }, { word: '石化流', meaning: '一套打法' }])
  const list = mem.slangOf('123')
  assert.equal(list.length, 2)
  assert.equal(list.find((x) => x.word === '面包片').meaning, '平民配装')
  // 同词更新而不是新增
  mem.putSlang('123', [{ word: '面包片', meaning: '新出的平民配装，卡片便宜' }])
  const after = mem.slangOf('123')
  assert.equal(after.length, 2, '同词合并')
  assert.match(after.find((x) => x.word === '面包片').meaning, /卡片便宜/)
})

test('黑话不占相处经验的槽位（reflect 覆盖 insights 也不影响黑话）', async () => {
  const mem = await freshStore()
  mem.putSlang('123', [{ word: '面包片', meaning: '平民配装' }])
  mem.setInsights('group:123', [{ text: '他累的时候别多聊' }])
  assert.equal(mem.insights().find((x) => x.key === 'group:123').list.length, 1, '相处经验只有自己那条')
  assert.equal(mem.slangOf('123').length, 1, '黑话还在')
  // 模拟 reflect 整体覆盖 insights
  mem.setInsights('group:123', [{ text: '换了一条经验' }])
  assert.equal(mem.slangOf('123').length, 1, '黑话不受 insights 覆盖影响')
})

test('容量上限 12 条，新的在前', async () => {
  const mem = await freshStore()
  for (let i = 0; i < 15; i++) mem.putSlang('123', [{ word: '词' + i, meaning: '意思' + i }])
  const list = mem.slangOf('123')
  assert.equal(list.length, 12, '超上限截断')
  assert.equal(list[0].word, '词14', '新的在前')
})

test('删除单条', async () => {
  const mem = await freshStore()
  mem.putSlang('123', [{ word: '甲', meaning: '1' }, { word: '乙', meaning: '2' }])
  const target = mem.slangOf('123').find((x) => x.word === '甲')
  assert.equal(mem.removeSlang('123', target.id), true)
  assert.deepEqual(mem.slangOf('123').map((x) => x.word), ['乙'])
  assert.equal(mem.removeSlang('123', 'nope'), false)
})

test('面板接口与注入路径都接上了', () => {
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/slang'/)
  assert.match(mod, /api\.route\('\/slang\/save'/)
  assert.match(mod, /api\.route\('\/slang\/delete'/)
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.match(mem, /这个群的黑话，听懂了就用、别硬套/, 'contextFor 单独注入')
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function SlangBook/, '面板有独立卡片')
  assert.match(client, /post\('\/slang\/save'/)
  // 1.3.60b：群选择器（不再平铺所有群）+ 记忆库「翻一翻」默认收起
  assert.match(client, /选群/)
  assert.match(client, /browseOpen, setBrowseOpen\] = useState\(false\)/, '翻一翻默认收起')
  // 1.3.59：黑话本和「蒸馏群友（学人）」分成两张独立卡，都不再埋在「记忆库」卡片里
  assert.match(client, /h\(Card, \{ title: '群黑话本（学一个群在用什么词）', right: f\.sw\('memory\.slang'\)/)
  assert.match(client, /h\(Card, \{ title: '蒸馏群友（学一个人的说话样子）'/)
})
