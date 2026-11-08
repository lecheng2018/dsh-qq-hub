// M2-B 契约测试：Session Registry（fake DSH，不碰 hub）
// 任务书必测：同聊天并发只创建一次；不同聊天不串；创建失败释放 in-flight；
// 重启恢复；旧映射只读迁移；跨 ChatKey 不可见；损坏记录失败关闭；dispose。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionRegistry } from '../src/chat/session-registry.js'
import { createSessionFileStore, migrateLegacySessions } from '../src/chat/session-store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 受控 fake DSH：记录创建调用、可注入延迟/失败。 */
function fakeDsh({ delayMs = 0, failFor = [] } = {}) {
  const created = []
  let n = 0
  const api = {
    created,
    failFor,
    createSession: async (chatKey) => {
      if (delayMs) await sleep(delayMs)
      if (api.failFor.includes(chatKey)) throw new Error(`开不了 ${chatKey} 的会话`)
      const sessionId = `sess-${++n}`
      created.push({ chatKey, sessionId })
      return { sessionId, agentId: `agent-${n}` }
    },
  }
  return api
}

test('同聊天并发首消息：两条并发消息只创建一次（single-flight）', async () => {
  const dsh = fakeDsh({ delayMs: 30 })
  const reg = createSessionRegistry({ createSession: dsh.createSession })
  const [a, b] = await Promise.all([
    reg.sessionFor('private:10001'),
    reg.sessionFor('private:10001'),
  ])
  assert.equal(a.sessionId, b.sessionId, '并发共享同一次创建结果')
  assert.equal(a.created, true)
  assert.equal(b.created, false, '等待方标记为非新建')
  assert.equal(dsh.created.length, 1, 'DSH 只被调一次')
  await reg.dispose()
})

test('不同聊天不串 session：各自独立创建，跨 ChatKey 不可见', async () => {
  const dsh = fakeDsh()
  const reg = createSessionRegistry({ createSession: dsh.createSession })
  const p = await reg.sessionFor('private:10001')
  const g = await reg.sessionFor('group:777')
  const other = await reg.sessionFor('private:555')
  assert.notEqual(p.sessionId, g.sessionId)
  assert.notEqual(p.sessionId, other.sessionId)
  assert.equal(dsh.created.length, 3)
  assert.equal(reg.peek('private:10001').sessionId, p.sessionId)
  assert.equal(reg.peek('group:777').sessionId, g.sessionId)
  assert.equal(reg.peek('private:555').sessionId, other.sessionId)
  // 跨键隔离： forget 一个不影响别的
  assert.equal(reg.forget('private:10001'), true)
  assert.equal(reg.peek('private:10001'), null)
  assert.equal(reg.peek('group:777').sessionId, g.sessionId)
  await reg.dispose()
})

test('创建失败：in-flight 释放，下次调用可重试且成功', async () => {
  const dsh = fakeDsh({ failFor: ['private:10001'] })
  const reg = createSessionRegistry({ createSession: dsh.createSession })
  await assert.rejects(() => reg.sessionFor('private:10001'), /开不了/)
  assert.equal(reg.peek('private:10001'), null, '失败不留半份映射')
  // 并发失败：两个等待者都收到同一错误，且 in-flight 清空
  dsh.failFor.length = 0
  const again = await reg.sessionFor('private:10001')
  assert.ok(again.created, '重试成功')
  await reg.dispose()
})

test('并发创建失败：所有等待者收到同一错误（in-flight 共享 reject），之后可重试', async () => {
  let fail = true
  const reg = createSessionRegistry({
    createSession: async () => { await sleep(20); if (fail) throw new Error('DSH 抽风'); return { sessionId: 's1' } },
  })
  const results = await Promise.allSettled([reg.sessionFor('private:1'), reg.sessionFor('private:1'), reg.sessionFor('private:1')])
  assert.equal(results.filter((r) => r.status === 'rejected').length, 3, '三个等待者全部收到失败')
  fail = false
  const ok = await reg.sessionFor('private:1')
  assert.equal(ok.sessionId, 's1')
  await reg.dispose()
})

test('重启恢复：持久化映射直接读回，不重建会话（created=false）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2b-reg-'))
  try {
    const store = createSessionFileStore({ file: join(dir, 'sessions.json') })
    const dsh = fakeDsh()
    const reg1 = createSessionRegistry({ createSession: dsh.createSession, store })
    await reg1.sessionFor('private:10001')
    await reg1.sessionFor('group:777')
    await reg1.dispose()

    // 「重启」：新 registry + 同一 store
    const dsh2 = fakeDsh()
    const reg2 = createSessionRegistry({ createSession: dsh2.createSession, store })
    const p = await reg2.sessionFor('private:10001')
    assert.equal(p.created, false, '恢复自持久化，不新建')
    assert.equal(dsh2.created.length, 0, 'DSH 零调用')
    assert.equal(reg2.stats.recovered, 2)
    await reg2.dispose()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('损坏记录：单条损坏跳过并上报；整库损坏失败关闭（空映射起步，不猜脏数据）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2b-reg-'))
  try {
    // 单条损坏
    const file1 = join(dir, 'a.json')
    writeFileSync(file1, JSON.stringify({ version: 1, chats: { 'group:777': { sessionId: 'ok-s' }, 'bogus-key': { sessionId: 'x' }, 'private:555': {} } }))
    const errors = []
    const store1 = createSessionFileStore({ file: file1 })
    const reg1 = createSessionRegistry({ createSession: async () => ({ sessionId: 'new' }), store: store1, onError: (e) => errors.push(e.message) })
    assert.equal(reg1.peek('group:777').sessionId, 'ok-s', '好记录读回')
    assert.equal(reg1.peek('private:555'), null, '缺 sessionId 的记录丢弃')
    assert.ok(errors.length >= 1, '损坏上报')
    await reg1.dispose()

    // 整库损坏
    const file2 = join(dir, 'b.json')
    writeFileSync(file2, '{ 这是坏 JSON')
    const store2 = createSessionFileStore({ file: file2 })
    const errors2 = []
    const reg2 = createSessionRegistry({ createSession: async () => ({ sessionId: 'new' }), store: store2, onError: (e) => errors2.push(e.message) })
    assert.equal(reg2.snapshot() && Object.keys(reg2.snapshot()).length, 0, '整库损坏 = 空映射起步')
    assert.ok(errors2.length >= 1)
    // 后续照常可用
    const fresh = await reg2.sessionFor('private:1')
    assert.ok(fresh.created)
    await reg2.dispose()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('旧映射只读迁移：导入成功、幂等、损坏跳过，不写回旧文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2b-reg-'))
  try {
    const legacyFile = join(dir, 'legacy-sessions.json')
    writeFileSync(legacyFile, JSON.stringify({
      chats: {
        'group:777': { sessionId: 'legacy-g', createdAt: 123 },
        'private:555': { sessionId: 'legacy-p' },
        '666': { sessionId: 'legacy-bare' }, // 裸 QQ 号键
        'bad-key!!': { sessionId: 'x' },     // 无法成键
        'empty': {},                          // 缺 sessionId
      },
    }))
    const store = createSessionFileStore({ file: join(dir, 'sessions.json') })
    const r1 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r1.imported, 3)
    assert.deepEqual(r1.skipped.sort(), ['bad-key!!', 'empty'])
    const loaded = store.load()
    assert.equal(loaded['group:777'].sessionId, 'legacy-g')
    assert.equal(loaded['private:666'].sessionId, 'legacy-bare', '裸 QQ 号补 private: 前缀')

    // 幂等：再迁移一次数量不变（合并不重复）
    const r2 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r2.imported, 3)
    assert.equal(Object.keys(store.load()).length, 3)

    // 不写回旧文件：旧文件内容原样
    const legacyNow = JSON.parse(readFileSync(legacyFile, 'utf8'))
    assert.ok(legacyNow.chats['bad-key!!'], '旧文件零改动（只读迁移）')

    // 没有旧文件 = 无需迁移，幂等空报告
    const r3 = migrateLegacySessions({ legacyFile: join(dir, 'nope.json'), store })
    assert.equal(r3.imported, 0)
    assert.equal(r3.errors.length, 0)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('旧映射迁移防倒退：二次迁移携带陈旧 sessionId 时保留 store 新值，记 conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2b-mig-'))
  try {
    const legacyFile = join(dir, 'stale-legacy.json')
    writeFileSync(legacyFile, JSON.stringify({
      chats: { 'group:777': { sessionId: 'old-g' }, 'private:555': { sessionId: 'same-p' } },
    }))
    const store = createSessionFileStore({ file: join(dir, 'sessions.json') })
    const r1 = migrateLegacySessions({ legacyFile, store })
    assert.equal(r1.imported, 2)

    // 模拟迁移后会话轮换：store 里 group:777 的映射比旧文件更新
    store.save({ 'group:777': { sessionId: 'new-g' }, 'private:555': { sessionId: 'same-p' } })

    // 再跑一次同一迁移（旧文件仍带陈旧的 old-g）
    const r2 = migrateLegacySessions({ legacyFile, store })
    assert.deepEqual(r2.conflicts, ['group:777'], '陈旧且不同的映射记入 conflicts，不覆盖新值')
    assert.equal(r2.imported, 1, '同值映射照常计 imported（幂等语义不变）')
    const loaded = store.load()
    assert.equal(loaded['group:777'].sessionId, 'new-g', '新值绝不被陈旧旧映射覆盖')
    assert.equal(loaded['private:555'].sessionId, 'same-p')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('dispose：拒绝新请求；等待在飞的创建落定；内存清零（无残留监听）', async () => {
  const dsh = fakeDsh({ delayMs: 40 })
  const reg = createSessionRegistry({ createSession: dsh.createSession })
  await reg.sessionFor('private:1')
  const pending = reg.sessionFor('private:2') // 在飞
  const disposeP = reg.dispose()
  await assert.rejects(() => reg.sessionFor('private:3'), /已卸载/)
  assert.equal((await pending).sessionId, 'sess-2', '在飞的创建正常落定给等待者')
  await disposeP
  assert.equal(Object.keys(reg.snapshot()).length, 0, '内存清空')
  // dispose 后持久化文件仍在（store 自身负责数据安全）
})

test('非法 ChatKey：绝不创建无主映射', async () => {
  const dsh = fakeDsh()
  const reg = createSessionRegistry({ createSession: dsh.createSession })
  await assert.rejects(() => reg.sessionFor('10001'), TypeError)
  await assert.rejects(() => reg.sessionFor('group:abc'), TypeError)
  assert.equal(dsh.created.length, 0, 'DSH 零调用')
  await reg.dispose()
})
