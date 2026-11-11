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

test('接线：学习已迁独立模块 slang（自带日程+共享流水），开关 memory.slang 默认关', () => {
  const mod = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  assert.match(mod, /cfg\.memory\?\.slang === true/, '默认关（面板开关打开才学）')
  assert.match(mod, /api\.every\(60_000/, '模块自己挂每日日程')
  assert.match(mod, /chatLog: api\.core\.chatLog/, '模块接宿主共享流水，不依赖记忆整理时序')
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.ok(!mem.includes('learnGroupSlang'), 'memory.js 旧实现已移交')
  const idx = readFileSync(new URL('../src/modules/index.js', import.meta.url), 'utf8')
  assert.match(idx, /import slang from '\.\/slang\/index\.js'/, 'BUILTINS 已注册')
  const cfg = readFileSync(new URL('../src/core/config.js', import.meta.url), 'utf8')
  assert.match(cfg, /c\.memory\.slang = bool\(c\.memory\.slang, false\)/)
})

test('黑话产物与来源进度一起持久化，失败不标成功，重启不重复调用', async (t) => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createSlangEngine } = await import('../src/modules/slang/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'slang-progress-'))
  const file = join(dir, 'book.json')
  const engines = []
  t.after(() => {
    engines.forEach((engine) => engine.dispose())
    rmSync(dir, { recursive: true, force: true })
  })
  const day = '2026-11-10'
  const rows = Array.from({ length: 12 }, (_, i) => ({ chatId: 'group:777', uid: String(i), text: `石化流这波太强了 ${i}` }))
  let fail = true
  let calls = 0
  const create = () => {
    const engine = createSlangEngine({
      config: () => ({ enabled: true, memory: { slang: true } }),
      chatLog: { listDays: () => [day], readDay: () => rows },
      loadState: () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      saveState: (state) => writeFileSync(file, JSON.stringify(state)),
      askModelImpl: async () => {
        calls++
        if (fail) throw new Error('模型暂时失败')
        return '[{"word":"石化流","meaning":"一套打法"}]'
      },
      log: { warn() {} },
    })
    engines.push(engine)
    return engine
  }
  const first = create()
  assert.equal((await first.learnDay(day)).results[0].ok, false)
  assert.equal(existsSync(file), false, '失败不保存产物或成功进度')
  fail = false
  assert.equal((await first.learnDay(day)).results[0].ok, true)
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(state.groups['777'][0].word, '石化流')
  assert.deepEqual(state.learned[day], ['777'])
  assert.equal(state.sources[day]['777'].count, rows.length)
  assert.match(state.sources[day]['777'].fingerprint, /^[a-f0-9]{64}$/)
  first.dispose()
  const before = calls
  assert.equal((await create().learnDay(day)).results[0].ok, true)
  assert.equal(calls, before, '成功游标重启后仍有效')
  const mod = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.dataDir\('book\.json'\)/, '模块命名空间存储')
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.ok(!mem.includes("setInsights(key, merged, '黑话本')"), '不和相处经验共用槽位')
})
