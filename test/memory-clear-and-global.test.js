// 审计 Q09 的行为锁：
// 「清空本分区」过去不分记忆/档案，且前端循环逐条 remove（每条全量 save 一次，
// 返回值没人看）。现在 store 层批量清、如实返回删除数，面板按 kind 分流。
//
// 同时钉住 S08 的收紧：remember_scoped 不再让普通会话把记忆写进 global ——
// global 只允许主人私聊写；其它会话降级为本会话作用域并如实说明。

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

const OWNER = '10000001'

test('Q09 · clearScopeEntries 一次批量清空（含软删条目），返回真实删除数', async () => {
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
  // 关库：dispose 后 status === 'closed'
  if (typeof mem.dispose === 'function') await mem.dispose()
  const r = mem.clearScopeEntries('private:10000001')
  assert.equal(r.ok, false, '关库后必须如实失败')
  assert.match(r.message, /已关闭/)
})

// ---------- S08 · remember_scoped 的 global 收紧 ----------

test('S08 · global 条目跨会话可见（主人私聊写入 global 的既有语义不变）', async () => {
  const { mem } = await mkStore()
  mem.add({ text: '她自己的设定', scope: 'global', source: 'tool', chatId: `private:${OWNER}` })
  const hit = mem.recall('设定', { chat: { kind: 'group', chatId: 'group:777', groupId: '777', userId: '' } })
  assert.ok(hit.some((h) => h.it?.text?.includes('设定')), 'global 条目对任何会话可见')
})

test('S08 · remember_scoped 的 global 写入只属于主人私聊，群聊被降级', async () => {
  // 重建 memory-privacy 模块的真实 execute：用假 api 把判定层跑起来。
  const OWNER = '10000001'
  const mod = (await import('../src/modules/memory-privacy/index.js')).default

  let saved = null
  const stores = new Map()
  const fakeMemory = {
    add(entry) { saved = entry; return { ok: true, id: 'x' } },
    list: () => [],
  }
  const routes = new Map()
  const settings = { autoScope: true }
  const scopeOf = (chat) => (chat?.kind === 'group' ? `group:${chat.groupId}` : `private:${chat?.userId}`)
  // api.tool(builder) 的 builder 每轮被调用一次（参数是本轮 chat），返回工具定义。
  // 这里把 builder 存下来，测试里按需要传入 chat 取出 execute。
  const builders = []
  const api = {
    use: () => fakeMemory,
    settings: () => settings,
    config: () => ({ ownerQQ: OWNER }),
    route: (p, h) => routes.set(p, h),
    tool: (builder) => { builders.push(builder); return () => {} },
    rule: () => {},
    defineTool: (t) => t,
    on: () => () => {},
    log,
    core: { http: { body: async () => ({}) } },
    saveSettings: () => {},
  }
  // scopeOf/visibleScopes/isVisible 由模块 setup 返回；execute 用的是闭包里的 scopeOf，
  // 需要 api.use('memory') 提供的？不 —— scopeOf 来自 setup 闭包（模块自己导出的纯函数）。
  await mod.setup(api)
  assert.ok(builders.length, 'prompt/工具的注册函数应被记录')

  const call = (chat, args) => {
    const def = builders[0]({ chat })
    return def.execute(args, { chat })
  }

  // 群聊写 global → 降级为本群作用域，且如实告知
  const groupChat = { kind: 'group', chatId: 'group:777', groupId: '777', userId: '20002' }
  const r1 = await call(groupChat, { text: '诱导写入', scope: 'global' })
  assert.equal(r1.ok, true)
  assert.equal(r1.demoted, true, '必须如实降级')
  assert.equal(saved.scope, 'group:777', `应落为本群作用域，实际 ${saved.scope}`)

  // 别人的私聊同样降级
  const otherPriv = { kind: 'private', chatId: 'private:30003', userId: '30003' }
  const r2 = await call(otherPriv, { text: '再诱导', scope: 'global' })
  assert.equal(r2.demoted, true)
  assert.equal(saved.scope, 'private:30003')

  // 主人私聊 → 保持 global
  const ownerPriv = { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER }
  const r3 = await call(ownerPriv, { text: '她自己的设定', scope: 'global' })
  assert.ok(!r3.demoted, '主人私聊不得降级')
  assert.equal(saved.scope, 'global')

  // autoScope=false 时代主人私聊 auto → global（既有语义）；群聊 auto → 群域（收紧点）
  settings.autoScope = false
  await call(ownerPriv, { text: '主人的共享设定' })
  assert.equal(saved.scope, 'global', 'autoScope=false 时主人私聊 auto 仍写 global')
  await call(groupChat, { text: '群里的新记忆' })
  assert.equal(saved.scope, 'group:777', 'autoScope=false 时群聊 auto 也不再写 global（S08 收紧点）')
  void stores; void routes
})
