// 审计 Q09 的行为锁：
// 「清空本分区」过去不分记忆/档案——面板的记忆与人物档案两个分区共用
// /memory-privacy/clear-main，而它只遍历 memory.list() 删记忆点：
//   · 「人物档案」分区点了清空，实际一条档案都不会被删（面板却报「已清空」）；
//   · 「记忆」分区是前端循环逐条 memory.remove(id)，每条全量 save 一次
//     （N 条 = N 次写盘 + N 次索引失效），remove 的返回值没人看——
//     主库关着时每条都静默失败，面板照样报成功。
//
// 修复：store 层批量清（一次 filter 一次 save）+ 如实返回删除数；
// 面板按 kind 分流（memory / profiles），确认状态与 React key 也按 kind 区分。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = { info() {}, warn() {}, debug() {} }
const dsh = {}

async function mkStore() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'qqhub-clear-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ model: { provider: 'p', model: 'm' } })
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, log })
  return { mem, cfg }
}

test('Q09 · clearScopeEntries 一次批量清空，返回真实删除数', async () => {
  const { mem } = await mkStore()
  mem.add({ text: '香菜不吃', scope: 'private:10000001', source: 'manual' })
  mem.add({ text: '爱吃火锅', scope: 'private:10000001', source: 'manual' })
  mem.add({ text: '群A的事', scope: 'group:777', source: 'manual' })

  const r = mem.clearScopeEntries('private:10000001')
  assert.equal(r.ok, true)
  assert.equal(r.items, 2, `该作用域应清掉 2 条，实际 ${r.items}`)

  // 别的作用域不受影响
  const rest = mem.clearScopeEntries('group:777')
  assert.equal(rest.items, 1)
})

test('Q09 · clearProfilesInScope 只清该作用域的档案，global 不动', async () => {
  const { mem } = await mkStore()
  // setProfile(qq, text, name, scope, personaId) —— 位置参数
  mem.setProfile('10000001', '主人养猫', '', 'private:10000001')
  mem.setProfile('20000002', '群友爱发图', '', 'group:777')
  mem.setProfile('30000003', '公共设定', '', 'global')

  const r = mem.clearProfilesInScope('private:10000001')
  assert.equal(r.ok, true)
  assert.equal(r.profiles, 1, `应清掉 1 份档案，实际 ${r.profiles}`)
  const rest = mem.profiles().map((p) => p.scope)
  assert.ok(!rest.includes('private:10000001'), '目标作用域档案应被清空')
  assert.ok(rest.includes('global'), 'global 档案不能被殃及')
})

test('Q09 · 主库关闭时批量清除如实失败，不再谎报已清空', async () => {
  const { mem } = await mkStore()
  mem.add({ text: 'x', scope: 'private:10000001', source: 'manual' })
  if (typeof mem.dispose === 'function') await mem.dispose()
  const r = mem.clearScopeEntries('private:10000001')
  assert.equal(r.ok, false, '关库后必须如实失败')
  assert.match(r.message, /已关闭/)
})

// ---- 清空必须连带让派生档案失效（Q09 回归） ----
// 单条 remove() 早就会调 staleProfilesIn，批量清空一开始漏了它：清空报成功，
// profileOf()/contextFor() 还拿已删事实投喂上下文。

const OWNER = '10000001'
const SCOPE = 'private:10000001'
const CHAT = { kind: 'private', userId: OWNER, chatId: 'private:10000001' }
const FACTS = ['主人养了一只叫年糕的猫', '主人讨厌香菜', '主人周末常去爬香山'] // buildProfile 少于 3 条不写档案

/** 带假模型流的主库：让 buildProfile 走生产代码路径生成真正的派生档案（origin: 'derived'）。 */
async function mkStoreWithDerivedProfile() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'qqhub-clear-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const mem = createMemoryStore({
    dsh: { llm: { stream: async function* () { yield { type: 'text-delta', text: '主人养了一只叫年糕的猫，讨厌香菜' } } } },
    getConfig: () => ({ ownerQQ: OWNER, model: { provider: 'test', model: 'm' }, memory: { enabled: true, recallCount: 4 } }),
    log,
  })
  for (const text of FACTS) mem.add({ text, about: OWNER, aboutName: '主人', scope: SCOPE })
  assert.equal(await mem.buildProfile(OWNER, SCOPE), true)
  const prof = mem.profiles().find((p) => p.scope === SCOPE)
  assert.equal(prof.origin, 'derived', '前置条件：档案必须是派生档案')
  assert.match(mem.contextFor(CHAT), /年糕/, '前置条件：清空前上下文里带着这些事实')
  return { mem }
}

test('Q09 回归 · 批量清空作用域后派生档案失效，profileOf/contextFor 不再返回已删事实', async () => {
  const { mem } = await mkStoreWithDerivedProfile()

  const r = mem.clearScopeEntries(SCOPE)
  assert.equal(r.ok, true)
  assert.equal(r.items, FACTS.length)
  assert.equal(r.staleProfiles, 1, '该作用域下的派生档案应被标记 stale')

  assert.equal(mem.profiles().find((p) => p.scope === SCOPE).stale, true)
  assert.equal(mem.profileOf(OWNER, SCOPE), null, '已失效的档案不能再被取出来')
  assert.doesNotMatch(mem.contextFor(CHAT), /年糕|香菜/, '上下文不能再出现已删除的事实')
})

test('Q09 回归 · 生产路由 /memory-privacy/clear-main 清空后不再注入已删事实', async () => {
  const { mem } = await mkStoreWithDerivedProfile()
  const routes = await mountPrivacyModule(mem)

  const r = await routes['/memory-privacy/clear-main']({ query: { scope: SCOPE } })
  assert.equal(r.ok, true)
  assert.match(r.message, /已清空 3 条/)

  assert.equal(mem.profileOf(OWNER, SCOPE), null, '面板清空后档案必须失效')
  assert.doesNotMatch(mem.contextFor(CHAT), /年糕|香菜/, '面板清空后上下文不能再出现已删除的事实')
})

/** 用假 api 把 memory-privacy 模块的 setup 跑起来，拿到它注册的真实路由处理函数。 */
async function mountPrivacyModule(mem) {
  const routes = {}
  const noop = () => {}
  const api = {
    use: (name) => (name === 'memory' ? mem : null),
    route: (path, handler) => { routes[path] = handler },
    settings: () => ({}),
    config: () => ({ ownerQQ: OWNER }),
    log,
    tool: noop,
    rule: noop,
    on: noop,
    saveSettings: noop,
    defineTool: (def) => def,
    core: { http: { body: async () => ({}) } },
  }
  const { default: mod } = await import('../src/modules/memory-privacy/index.js')
  mod.setup(api)
  assert.equal(typeof routes['/memory-privacy/clear-main'], 'function')
  return routes
}
