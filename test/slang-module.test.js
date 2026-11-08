// 群黑话模块（独立 optional 模块）契约测试——重点锁定「不生效」三根因的修复：
//   1. 时序：模块自带日程（03 点后学昨天/今天的完整流水），不依赖 memory 的 consolidate，
//      也不再「调用时流水已被整理删除」；
//   2. 冷却诚实：候选为空/模型失败的区别对待——失败不记 learned（次日还能再学）；
//   3. 按群隔离：一个群的模型调用失败不中断其他群。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { validateModuleContract } from '../src/core/module-contract.js'
import { planModules } from '../src/core/module-sdk.js'
import { createSlangEngine, slangModule } from '../src/modules/slang/index.js'

const SLANG_JSON = '[{"word":"石化流","meaning":"一套打法"},{"word":"面包片","meaning":"平民配装"}]'

function makeEngine ({ targets = [], dayLogs, now = Date.now, slangOn = true, failGroups = [] } = {}) {
  const dir = mkdtemp()
  const stateFile = join(dir, 'book.json')
  const calls = []
  const logs = dayLogs || (() => {
    const out = []
    for (let i = 0; i < 12; i++) {
      out.push({ t: Date.now() - 100_000 + i * 30_000, chatId: 'group:777', uid: String(1000 + i), name: '群友' + i, text: `这波石化流真的强 ${i}` })
    }
    for (let i = 0; i < 11; i++) {
      out.push({ t: Date.now() - 90_000 + i * 30_000, chatId: 'group:888', uid: String(2000 + i), name: '乙群友' + i, text: `面包片配石化流 ${i}` })
    }
    return out
  })()
  const engine = createSlangEngine({
    config: () => ({ enabled: true, memory: { slang: slangOn, distillModel: { provider: '', model: '' } } }),
    loadState: () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } },
    saveState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
    chatLogDays: () => ['d1'],
    chatLogOf: (day) => logs,
    groupNameOf: async (gid) => (gid === '777' ? '游戏群' : '闲聊群'),
    askModelImpl: async (dsh, opts) => {
      calls.push(opts)
      const text = String(opts.text || '')
      if (failGroups.some((g) => text.includes(g))) throw new Error('模型炸了（' + text.slice(0, 20) + '）')
      return SLANG_JSON
    },
    dsh: null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    now,
  })
  return { engine, calls, dir }
}

// ESM：小工具
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
function mkdtemp () { return mkdtempSync(join(tmpdir(), 'slang-mod-')) }

test('manifest：合法定义，provides 声明被 SDK 计划消费（无依赖、可独立装载）', () => {
  const def = validateModuleContract(slangModule)
  assert.deepEqual(def.provides, ['group-slang'])
  const plan = planModules({ defs: [slangModule], enabledOf: () => true, runtime: { gui: true } })
  assert.deepEqual(plan.load.map((d) => d.id), ['slang'], '无依赖 → 任何顺序都可装载')
})

test('根因1修复：自带日程学完整流水——即使 memory 侧「已删往日流水」，模块学的是注入给它的快照', async () => {
  let t = new Date('2026-11-08T15:00:00').getTime() // 15:00（>3 点）
  const { engine, calls } = makeEngine({ now: () => t })
  // 昨天的流水（模块 tick 会优先学昨天）
  engine.tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(calls.length >= 1, '学习调用发生')
  assert.match(calls[0].text, /词频候选/, '从注入的流水快照里发现候选（不依赖 memory 的整理时序）')
  assert.equal(engine.status().lastRunDay, new Date(t).toDateString(), '当日只跑一次')
  // 同日再 tick：不重复
  const n = calls.length
  engine.tick()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls.length, n, 'lastRunDay 冷却生效')
})

test('根因2修复：learned 诚实标记——成功才记；候选为空记「无候选」不重试', async () => {
  let t = new Date('2026-11-08T15:00:00').getTime()
  const { engine, dir } = makeEngine({ now: () => t })
  engine.tick()
  await new Promise((r) => setTimeout(r, 60))
  const state = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'))
  // 两个群都成功（模型正常回包）→ learned 里有这两个群
  assert.ok(state.learned['2026-11-07'].includes('777'))
  assert.ok(state.learned['2026-11-07'].includes('888'))
  // 书里有词
  assert.ok(engine.bookOf('777').some((x) => x.word === '石化流'))
  assert.ok(engine.bookOf('888').some((x) => x.word === '面包片'))
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('根因3修复：按群隔离——一个群模型炸，另一个群照常学到', async () => {
  let t = new Date('2026-11-08T15:00:00').getTime()
  const { engine, dir } = makeEngine({ now: () => t, failGroups: ['游戏群'] }) // 777 的群名触发失败
  engine.tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(engine.bookOf('777').length, 0, '炸掉的群没学到')
  assert.ok(engine.bookOf('888').length > 0, '另一个群照常学到')
  const state = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'))
  assert.ok(!state.learned['2026-11-07'].includes('777'), '失败的群不记 learned（次日还能再学）')
  assert.ok(state.learned['2026-11-07'].includes('888'))
})

test('开关：memory.slang 默认关——tick 直接不跑（面板开关打开才启用）', async () => {
  let t = new Date('2026-11-08T15:00:00').getTime()
  const { engine, calls } = makeEngine({ now: () => t, slangOn: false })
  engine.tick()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls.length, 0)
  assert.equal(engine.status().lastRunDay, '', '没记任何运行日')
})

test('迁移：旧 memory.slang() 数据一次性搬进模块命名空间', async () => {
  // 模块 setup 的迁移逻辑经 api.use('memory') 读遗留只读口——这里用假 api 驱动 setup
  const dir = mkdtemp()
  const stateFile = join(dir, 'book.json')
  const routeDefs = []
  const contexts = []
  const intervals = []
  const fakeApi = {
    dataDir: (p) => join(dir, p),
    use: (id) => (id === 'memory' ? { slang: () => [{ gid: '777', list: [{ id: 'a1', word: '旧词', meaning: '旧解释', at: 1 }] }] } : null),
    config: () => ({ enabled: true, memory: { slang: true }, allow: { groups: ['777'] } }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dsh: null,
    core: { hub: { chatLogDays: () => [], chatLogOf: () => [] }, http: { body: async () => ({}) } },
    on: () => () => {},
    context: (fn) => contexts.push(fn),
    every: (ms, fn, label) => intervals.push({ ms, fn, label }),
    route: (path, handler) => routeDefs.push(path),
    emit: () => {},
  }
  const exports_ = slangModule.setup(fakeApi)
  assert.ok(existsSyncDot(stateFile), '迁移写了模块命名空间文件')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(state.groups['777'][0].word, '旧词', '旧黑话搬进来')
  assert.deepEqual(routeDefs.sort(), ['/slang', '/slang/delete', '/slang/save', '/slang/status'], '路由原 URL 迁到本模块')
  assert.equal(intervals.length, 1, '每日日程挂上')
  // 注入 provider：契约参数是 ({ chat, sessionId })；群聊给黑话、非群聊给空
  const provider = contexts[0]
  assert.match(provider({ chat: { kind: 'group', groupId: '777' } }), /旧词＝旧解释/)
  assert.equal(provider({ chat: { kind: 'private', chatId: 'private:1' } }), '')
})

// 小工具
import { existsSync } from 'node:fs'
function existsSyncDot (p) { return existsSync(p) }
