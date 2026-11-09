// 群黑话本存储与面板（1.3.58；2026-11-08 随模块化重构迁到独立模块 src/modules/slang/）。
// 背景：1.3.53 把黑话写进 insights[key]，和相处经验共用 8 条槽位；
// reflect() 每轮整理会整体覆盖那个数组，模型不知道【黑话】条目存在 → 学到的黑话下一轮就没了。
// 1.3.58 起独立存储；2026-11-08 起存储在模块命名空间（modules-data/slang/book.json），不再写 memory.json。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createSlangEngine } from '../src/modules/slang/index.js'

function freshEngine (state = {}) {
  let saved = { groups: {}, learned: {}, ...state }
  const engine = createSlangEngine({
    config: () => ({ enabled: true, memory: { slang: true } }),
    loadState: () => saved,
    saveState: (s) => { saved = s },
    chatLogDays: () => [],
    chatLogOf: () => [],
    log: { info() {}, warn() {}, debug() {}, error() {} },
  })
  return { engine, getState: () => saved }
}

test('黑话独立存储：写入/读取/同词更新，不和 insights 抢槽位', () => {
  const { engine } = freshEngine()
  engine.putBook('123', [{ word: '面包片', meaning: '平民配装' }, { word: '石化流', meaning: '一套打法' }])
  const list = engine.bookOf('123')
  assert.equal(list.length, 2)
  assert.equal(list.find((x) => x.word === '面包片').meaning, '平民配装')
  // 同词更新而不是新增
  engine.putBook('123', [{ word: '面包片', meaning: '新出的平民配装，卡片便宜' }])
  const after = engine.bookOf('123')
  assert.equal(after.length, 2, '同词合并')
  assert.match(after.find((x) => x.word === '面包片').meaning, /卡片便宜/)
  // 与 insights（相处经验，仍归 memory 模块）互不影响：引擎状态里根本没有 insights
})

test('容量上限 12 条，新的在前', () => {
  const { engine } = freshEngine()
  for (let i = 0; i < 15; i++) engine.putBook('123', [{ word: '词' + i, meaning: '意思' + i }])
  const list = engine.bookOf('123')
  assert.equal(list.length, 12, '超上限截断')
  assert.equal(list[0].word, '词14', '新的在前')
})

test('删除单条', () => {
  const { engine } = freshEngine()
  engine.putBook('123', [{ word: '甲', meaning: '1' }, { word: '乙', meaning: '2' }])
  const target = engine.bookOf('123').find((x) => x.word === '甲')
  assert.equal(engine.removeItem('123', target.id), true)
  assert.deepEqual(engine.bookOf('123').map((x) => x.word), ['乙'])
  assert.equal(engine.removeItem('123', 'nope'), false)
})

test('注入文本：带词＝义列表；空本返回空串（不占注入位）', () => {
  const { engine } = freshEngine()
  assert.equal(engine.hintFor('123'), '')
  engine.putBook('123', [{ word: '石化流', meaning: '一套打法' }])
  assert.match(engine.hintFor('123'), /石化流＝一套打法/)
  assert.match(engine.hintFor('123'), /听懂了就用、别硬套/)
})

test('面板接口与注入路径都接上了（独立模块，URL 不变）', () => {
  const mod = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/slang'/)
  assert.match(mod, /api\.route\('\/slang\/save'/)
  assert.match(mod, /api\.route\('\/slang\/delete'/)
  assert.match(mod, /api\.context\(/, '注入走模块自己的 context provider')
  assert.match(mod, /api\.use\('memory'\)\?\.slang\?\.\(\)/, '旧本迁移走 memory 只读口')
  const memoryMod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(memoryMod, /api\.route\('\/slang'/, 'memory 模块不再挂 slang 路由')
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function SlangBook/, '面板有独立卡片')
  assert.match(client, /post\('\/slang\/save'/)
  // 1.3.60b：群选择器（不再平铺所有群） 「记忆库·黑话本」页默认收起
  assert.match(client, /选群/)
  assert.match(client, /browseOpen, setBrowseOpen\] = useState\(false\)/, '翻一翻默认收起')
  // 1.3.59：黑话本和「蒸馏群友（学人）」分成两张独立卡片
  assert.match(client, /h\(Card, \{ title: '群黑话本（学一个群在用什么词）', right: f\.sw\('memory\.slang'\)/)
  assert.match(client, /h\(Card, \{ title: '蒸馏群友（学一个人的说话样子）'/)
})
