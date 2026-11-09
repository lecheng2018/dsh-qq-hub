// M2-E 契约测试：Context Assembly
// 任务书必测：memory/mood/token-guardian/group-admin/multi-parser 等贡献均保留；
// 无 scope fail-closed；群聊无私聊记忆；speaker 档案获得真实 sessionId；单模块异常按声明策略降级。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createContextAssembly } from '../src/chat/context-assembly.js'

test('全 provider 贡献保留：memory/mood/token-guardian/group-admin/multi-parser 一次装配全拿到', async () => {
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'memory', priority: 100, provide: () => '长期记忆：主人爱吃白米饭' },
      { moduleId: 'mood', priority: 10, provide: () => '当前心情：开心' },
      { moduleId: 'token-guardian', priority: -5, provide: () => '' }, // 空贡献不产出
      { moduleId: 'group-admin', scope: 'group:777', priority: 20, provide: () => '机器人是群主' },
      { moduleId: 'multi-parser', priority: 0, provide: () => '最近解析过一条 B 站链接' },
    ],
  })
  const { fragments, errors } = await assembly.assemble({ chatKey: 'group:777', sessionId: 'sess-9' })
  assert.deepEqual(errors, [])
  const ids = fragments.map((f) => f.moduleId)
  assert.ok(ids.includes('memory') && ids.includes('mood') && ids.includes('group-admin') && ids.includes('multi-parser'), '贡献都在')
  assert.ok(!ids.includes('token-guardian'), '空贡献不占装配位')
  // 顺序稳定：priority 降序（memory 100 > group-admin 20 > mood 10 > multi-parser 0）
  assert.deepEqual(ids, ['memory', 'group-admin', 'mood', 'multi-parser'])
  // 契约字段齐全
  const mem = fragments.find((f) => f.moduleId === 'memory')
  assert.equal(mem.scope, 'global', 'global provider 如实保留 global 出处（可见域 = 全局）')
  assert.equal(mem.sessionId, 'sess-9', '拿到真实 sessionId')
  assert.equal(mem.cacheStable, false)
  assert.equal(mem.onError, 'isolate')
})

test('scope 隔离：群聊拿不到私聊 provider 的贡献（物理隔离）', async () => {
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'private-memory', scope: 'private:10001', provide: () => '主人私聊里的秘密' },
      { moduleId: 'group-note', scope: 'group:777', provide: () => '群里的约定' },
      { moduleId: 'global-persona', scope: 'global', provide: () => '人格卡' },
    ],
  })
  const group = await assembly.assemble({ chatKey: 'group:777', sessionId: 's' })
  assert.deepEqual(group.fragments.map((f) => f.moduleId), ['group-note', 'global-persona'], '群聊只见 global + 自己的 scope（同优先级按注册序）')
  const priv = await assembly.assemble({ chatKey: 'private:10001', sessionId: 's' })
  assert.deepEqual(priv.fragments.map((f) => f.moduleId), ['private-memory', 'global-persona'], '私聊不见群聊贡献')
})

test('无 scope 的装配请求 fail-closed：非法 ChatKey 直接抛，绝不全库兜底', async () => {
  const assembly = createContextAssembly({
    providers: [{ moduleId: 'memory', provide: () => '不该被拿到' }],
  })
  await assert.rejects(() => assembly.assemble({ chatKey: '10001' }), TypeError) // 裸 QQ 号
  await assert.rejects(() => assembly.assemble({}), TypeError)
  // provider 声明 scope 非法也在注册时即抛
  assert.throws(() => createContextAssembly({
    providers: [{ moduleId: 'bad', scope: 'random', provide: () => 'x' }],
  }), TypeError)
})

test('speaker 档案：provider 收到的 sessionId 是本次装配的真实会话（非全局伪造）', async () => {
  let seen = null
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'profile', provide: (req) => { seen = req; return `档案：会话 ${req.sessionId}` } },
    ],
  })
  await assembly.assemble({ chatKey: 'private:10001', sessionId: 'sess-real-1' })
  assert.equal(seen.sessionId, 'sess-real-1')
  assert.equal(seen.chatKey, 'private:10001')
})

test('单模块异常按声明策略降级：isolate 跳过自己、其余照常；fail-closed 整次装配失败', async () => {
  // isolate（缺省）
  const a1 = createContextAssembly({
    providers: [
      { moduleId: 'boom', provide: () => { throw new Error('该模块炸了') } },
      { moduleId: 'memory', priority: 50, provide: () => '正常记忆' },
    ],
  })
  const r1 = await a1.assemble({ chatKey: 'private:1', sessionId: 's' })
  assert.deepEqual(r1.fragments.map((f) => f.moduleId), ['memory'], '炸掉的跳过，其余照常')
  assert.equal(r1.errors.length, 1)
  assert.equal(r1.errors[0].moduleId, 'boom')

  // fail-closed：隐私型 provider 出错绝不带残缺上下文继续
  const a2 = createContextAssembly({
    providers: [
      { moduleId: 'memory-privacy', onError: 'fail-closed', provide: () => { throw new Error('隔离层不可用') } },
      { moduleId: 'memory', priority: 50, provide: () => '正常记忆' },
    ],
  })
  await assert.rejects(
    () => a2.assemble({ chatKey: 'private:1', sessionId: 's' }),
    /memory-privacy fail-closed/,
    'fail-closed = 整次失败，宁可无上下文不可错上下文',
  )
})

test('注册/注销：模块启停热生效，顺序保持稳定（同优先级按注册序）', async () => {
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'a', provide: () => 'A' },
      { moduleId: 'b', provide: () => 'B' },
    ],
  })
  const off = assembly.register({ moduleId: 'c', provide: () => 'C' })
  let r = await assembly.assemble({ chatKey: 'private:1', sessionId: 's' })
  assert.deepEqual(r.fragments.map((f) => f.moduleId), ['a', 'b', 'c'])
  off()
  r = await assembly.assemble({ chatKey: 'private:1', sessionId: 's' })
  assert.deepEqual(r.fragments.map((f) => f.moduleId), ['a', 'b'], '注销后消失')
  // 重复注册同 ID：同优先级按注册序（X1/X2 都显式 priority 1）
  assembly.register({ moduleId: 'x', priority: 1, provide: () => 'X1' })
  assembly.register({ moduleId: 'x', priority: 1, provide: () => 'X2' })
  r = await assembly.assemble({ chatKey: 'private:1', sessionId: 's' })
  assert.deepEqual(r.fragments.map((f) => f.moduleId + f.content), ['xX1', 'xX2', 'aA', 'bB'], '同 ID 同优先级按注册序，高优先级在前')
})

test('cacheStable 声明透传：稳定缓存 provider 如实标记（供 prompt 缓存优化决策）', async () => {
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'persona', cacheStable: true, priority: 200, provide: () => '人格卡（少变）' },
      { moduleId: 'recent', provide: () => '近况（多变）' },
    ],
  })
  const { fragments } = await assembly.assemble({ chatKey: 'private:2', sessionId: 's' })
  assert.equal(fragments[0].cacheStable, true)
  assert.equal(fragments[1].cacheStable, false)
})
