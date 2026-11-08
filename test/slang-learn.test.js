// 蒸馏群友（1.3.53）：黑话新词发现（纯本地统计）+ 提炼接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { discoverSlangCandidates } from '../src/features/slang-discover.js'

const lines = (arr) => arr.map((x) => (typeof x === 'string' ? { who: 'a', text: x } : x))

test('高频圈外词被挑出，常用词被白名单挡住', () => {
  const chat = lines([
    '这波石化流玩法太逆天了', '石化流真的强 建议直接抄作业', '昨天试了石化流 差点被送走',
    '面包片是什么梗', '面包片就是那个平民配装', '懂了 面包片配石化流 起飞',
    '石化流下周估计就削了', '面包片加石化流 已收藏', '抄作业了抄作业了', '带我一个',
  ])
  const cands = discoverSlangCandidates(chat)
  const words = cands.map((c) => c.word)
  assert.ok(words.includes('石化'), '石化 入选: ' + words)
  assert.ok(words.includes('面包'), '面包 入选')
  assert.ok(!words.some((w) => w === '建议' || w === '收藏' || w === '昨天'), '常用词不入选: ' + words)
})

test('样本不足（<10 行）不统计；候选带原句采样', () => {
  assert.equal(discoverSlangCandidates(lines(['石化流强', '石化流稳', '石化流好'])).length, 0)
  const chat = lines([
    '这波石化流玩法太逆天了', '石化流真的强', '昨天试了石化流', '面包片是什么梗',
    '面包片就是那个平民配装', '面包片配石化流 起飞', '石化流下周估计就削了', '面包片加石化流',
    '抄作业了', '带我一个',
  ])
  const cands = discoverSlangCandidates(chat)
  assert.ok(cands.every((c) => Array.isArray(c.samples) && c.samples.length <= 2), '每个候选带 ≤2 条原句')
  assert.ok(cands[0].samples[0].length <= 30)
})

test('接线：学习已迁独立模块 slang（自带日程+按群隔离），开关 memory.slang 默认关', () => {
  const mod = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  assert.match(mod, /cfg\.memory\?\.slang === true/, '默认关（面板开关打开才学）')
  assert.match(mod, /api\.every\(60_000/, '模块自己挂每日日程')
  assert.match(mod, /learnDay\(runDay\)/, '学习入口在模块日程里')
  assert.match(mod, /失败.*不记 learned|不记 learned/, '失败不记冷却（诚实标记）')
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.ok(!mem.includes('learnGroupSlang'), 'memory.js 旧实现已移交')
  const idx = readFileSync(new URL('../src/modules/index.js', import.meta.url), 'utf8')
  assert.match(idx, /import slang from '\.\/slang\/index\.js'/, 'BUILTINS 已注册')
  const cfg = readFileSync(new URL('../src/core/config.js', import.meta.url), 'utf8')
  assert.match(cfg, /c\.memory\.slang = bool\(c\.memory\.slang, false\)/)
})

test('提炼结果写进模块命名空间存储（1.3.58 起不挤 insights；模块化后不进 memory.json）', () => {
  const mod = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.dataDir\('book\.json'\)/, '模块命名空间存储')
  assert.match(mod, /putBook\(gid, items\)/, '写进独立黑话本')
  assert.match(mod, /markLearned\(day, gid\)/, '提炼过要记账，重启不重复花调用')
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.ok(!mem.includes("setInsights(key, merged, '黑话本')"), '不和相处经验共用槽位')
})
