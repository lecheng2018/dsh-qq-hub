// 记忆泄漏路径回归（2026-11-06，外部审查 #11）：
// memory-privacy 曾是真实泄漏事故的源头（人物小档案跨作用域、无 scope 当 global 放行）。
// 这组测试把三条高危路径钉死：profiles 跨域、recall fail-closed、隔离开关只放主人私聊。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVisible, scopeOf } from '../src/modules/memory-privacy/index.js'

const OWNER = '10000001'
const STRANGER = '20000000'
const GROUP = '888888'

const chatOf = (kind, id) => (kind === 'group' ? { chatId: 'group:' + id, kind: 'group', groupId: id } : { chatId: 'private:' + id, kind: 'private', userId: id })

test('profiles 作用域：主人私聊档案不能被群聊拿到（真实泄漏事故的回归钉）', () => {
  const masterProfile = { qq: OWNER, scope: 'private:' + OWNER, text: '主人养了猫叫粥粥' }
  assert.equal(isVisible(masterProfile, chatOf('private', OWNER)), true, '主人私聊可见')
  assert.equal(isVisible(masterProfile, chatOf('group', GROUP)), false, '群里物理不可见')
  assert.equal(isVisible(masterProfile, chatOf('private', STRANGER)), false, '别人私聊也不可见')
})

test('无 scope 条目：一律不可见（老数据不再当 global 放行）', () => {
  const legacy = { text: '某次聊天记的事' }
  for (const c of [chatOf('private', OWNER), chatOf('group', GROUP), chatOf('private', STRANGER)]) {
    assert.equal(isVisible(legacy, c), false, 'fail-closed')
  }
})

test('scopeOf：认不出的聊天类型落私有域，绝不落 global', () => {
  // null 是明确的「无聊天上下文」（系统路径），走 global；
  // 有对象但 kind 认不出（来源不明的消息）才落谁也不共享的 private:unknown。
  assert.equal(scopeOf({ kind: 'mystery' }), 'private:unknown')
  assert.equal(scopeOf({}), 'private:unknown')
  assert.equal(scopeOf({ kind: 'system' }), 'global')
})

test('global 条目处处可见；群条目只在群里', () => {
  const g = { text: 'x', scope: 'global' }
  for (const c of [chatOf('private', OWNER), chatOf('group', GROUP)]) assert.equal(isVisible(g, c), true)
  const gg = { text: 'x', scope: 'group:' + GROUP }
  assert.equal(isVisible(gg, chatOf('group', GROUP)), true)
  assert.equal(isVisible(gg, chatOf('private', OWNER)), false)
})

test('主库 recall fail-closed：无 chat 无 scopes 一律空（后端路径拿全库的通道已封）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memleak-'))
  process.env.AURABOT_DATA_DIR = dir
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ ownerQQ: OWNER, memory: { enabled: true } })
  const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub: {}, log: () => {}, personaText: () => '' })
  mem.add({ text: '主人私聊里的秘密', scope: 'private:' + OWNER, chatId: 'private:' + OWNER, source: 'tool' })
  // 无 chat 无 scopes：fail-closed（历史上后台任务曾靠这个拿到全库）
  assert.equal(mem.recall('秘密').length, 0, '不给域就什么也不给')
  // 显式声明别的域：拿不到主人私聊
  assert.equal(mem.recall('秘密', { scopes: ['group:' + GROUP] }).length, 0)
  // 主人私聊自己的 chat：可见
  assert.ok(mem.recall('秘密', { chat: chatOf('private', OWNER) }).length > 0)
  // 群聊 chat：物理过滤
  assert.equal(mem.recall('秘密', { chat: chatOf('group', GROUP) }).length, 0)
})
