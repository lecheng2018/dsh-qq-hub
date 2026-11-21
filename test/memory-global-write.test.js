// 审计 S08 的行为锁：
// remember_scoped 过去允许任何被 ACL 放行的会话（含群聊）把记忆写进 global ——
// 写入后所有会话无条件可见，诱导一次就等于向全部会话扩散。
//
// 收紧：global 的**写入**只属于主人私聊；其它会话一律降级为本会话作用域，
// 并在返回里如实说明（demoted: true），不让模型以为写成了 global。
// autoScope=false 的语义同步收紧：只对主人私聊生效（原来它让所有会话都写 global），
// 面板 hint 已更新说明。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const log = { info() {}, warn() {}, debug() {} }
const OWNER = '10000001'


async function mkStore() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'qqhub-g-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ model: { provider: 'p', model: 'm' } })
  const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, log })
  return { mem, cfg }
}

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
