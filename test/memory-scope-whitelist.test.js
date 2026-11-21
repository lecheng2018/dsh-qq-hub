// 审计 S08 后续：作用域白名单（存储层兜底）。
//
// 背景：remember_scoped 的 schema 声明 scope 只能是 auto/global，但 defineTool 不校验参数，
// 于是模型（或被群消息诱导的模型）传 private:<主人QQ> 就能把伪造事实写进主人的私聊记忆，
// 主人私聊召回时当成「自己私下知道的事」——工具层的白名单挡的是这一条，
// 这里锁的是更底下那一层：绕过工具直连 memory.add / 记忆总线的调用也过不去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = { info() {}, warn() {}, debug() {} }
const OWNER = '10000001'

async function mkStore() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'qqhub-scope-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ model: { provider: 'p', model: 'm' } })
  return createMemoryStore({ dsh: {}, getConfig: () => cfg, log })
}

const texts = (mem) => (mem.list() || []).map((m) => m.text)

test('isValidScope：只认 global / private:<id> / group:<id>，空串代表「按聊天推」不算非法', async () => {
  const { isValidScope } = await import('../src/features/memory-scope.js')
  for (const ok of ['', 'global', 'private:10000001', 'group:777', 'private:unknown', ' global ']) {
    assert.equal(isValidScope(ok), true, `应接受 ${JSON.stringify(ok)}`)
  }
  // 注意：白名单管的是**形状**，不是归属。'private:99999' 形状合法（那是 99999 自己的私聊域），
  // 存储层不拦；「谁能写进谁的作用域」是上面工具层的事（remember_scoped 现在只收 auto/global）。
  assert.equal(isValidScope('private:99999'), true)
  assert.equal(isValidScope('group:777\n'), true, '首尾空白会被 trim，等价于 group:777')
  for (const bad of ['private:', 'group:', 'public:1', 'auto', 'global:1', 'PRIVATE:1', 'private:  ', 'not-a-scope']) {
    assert.equal(isValidScope(bad), false, `应拒绝 ${JSON.stringify(bad)}`)
  }
})

test('主库 add 拒绝非法作用域，且一条都不落库；合法形状照常写', async () => {
  const mem = await mkStore()
  for (const bad of ['private:', 'group:', 'public:1', 'auto', 'not-a-scope']) {
    const r = mem.add({ text: '诱导写入 ' + bad, scope: bad })
    assert.equal(r.ok, false, `scope=${bad} 应被拒绝`)
    assert.match(r.message, /作用域不合法/)
  }
  assert.deepEqual(texts(mem).filter((t) => t.startsWith('诱导写入')), [], '被拒的条目不能留在库里')

  const ok = mem.add({ text: '正常：别人的私聊', scope: 'private:99999' })
  assert.equal(ok.ok, true, '形状合法的作用域（哪怕不是本会话）由上层判定，存储层不拦')
  const global = mem.add({ text: '正常：全局', scope: ' global ' })
  assert.equal(global.ok, true)
  assert.equal(mem.list().find((m) => m.text === '正常：全局').scope, 'global')

  // 空 scope 仍按聊天推断（group:5），不因为白名单而退化成 global
  const noScope = mem.add({ text: '正常：按聊天推', chatId: 'group:5' })
  assert.equal(noScope.ok, true)
  assert.equal(mem.list().find((m) => m.text === '正常：按聊天推').scope, 'group:5')
})

test('经历流水（addEvent）同样过白名单', async () => {
  const mem = await mkStore()
  const bad = mem.addEvent({ text: '经历：非法域', scope: 'public:1' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /作用域不合法/)
  assert.ok(!texts(mem).includes('经历：非法域'))
})

test('记忆总线：非法作用域在总线入口就被挡，合法值原样下传', async () => {
  const mem = await mkStore()
  const { createMemoryBus } = await import('../src/features/memory-bus.js')
  const bus = createMemoryBus({ store: mem, log })

  for (const bad of ['private:', 'public:1', 'auto']) {
    const r = bus.add({ text: '总线诱导 ' + bad, scope: bad })
    assert.equal(r.ok, false, `bus.add scope=${bad} 应被拒绝`)
    assert.match(r.message, /作用域不合法/)
  }
  assert.ok(!texts(mem).some((t) => t.startsWith('总线诱导')), '被总线拒掉的条目不能落库')

  const ok = bus.add({ text: '总线正常：本群', chat: { kind: 'group', groupId: '777', chatId: 'group:777' } })
  assert.equal(ok.ok, true)
  assert.equal(mem.list().find((m) => m.text === '总线正常：本群').scope, 'group:777')

  const ev = bus.addEvent({ text: '总线经历：非法', scope: 'public:1' })
  assert.equal(ev.ok, false)
  assert.match(ev.message, /作用域不合法/)
})