// 孤儿会话巡检（orphanSweep）：把 QQ 工作区里既不在聊天映射、也不在后台系统会话池
// 的历史会话静默归档；正在用的、刚建的、置顶的、别的项目的一律不碰。
//
// 背景（真机 2026-11-23）：服务重启后内存里的 `system:<key>` 映射会丢，昨天那批
// 「刷 B 站 / 逛热榜」会话就再没人认领，只会一直挂在侧栏（实测堆积 25 个）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const HOUR = 3600_000
const QQ_ROOT = '/tmp/orphan-sweep-qq'
const OTHER_ROOT = '/tmp/orphan-sweep-other'

/**
 * 最小 DSH：sessionController.list 给出会话摘要，workspaceRegistry 记录归档调用。
 * 对象必须是**稳定实例**（ctx.get 每次返回同一个），否则测试里没法替换方法做故障注入。
 * @param {{rows:Array, archived?:string[], pinned?:string[], createId?:string}} o
 */
function fakeDsh({ rows, archived = [], pinned = [], createId = 'sess-created' }) {
  const archivedIds = [...archived]
  const calls = []
  const controller = {
    create: async () => ({ sessionId: createId }),
    resolveAgent: async () => ({ agent: {} }),
    list: async () => ({ items: rows }),
  }
  const registry = {
    list: () => [],
    get archivedSessionIds() { return archivedIds },
    get pinnedSessionIds() { return pinned },
    archiveSession: async (id, opts = {}) => {
      calls.push({ id, opts })
      archivedIds.push(id)
    },
  }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      return null
    },
  }
  return { ctx, calls, archivedIds, controller, registry }
}

function mkCore(dsh, cfgOver = {}) {
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] },
    workspaceDir: QQ_ROOT,
    orphanSweep: { enabled: true, idleHours: 6, intervalHours: 6, maxPerPass: 20 },
    ...cfgOver,
  }
  return createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async () => ({}) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null, buildTools: () => [] },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
  })
}

const row = (id, over = {}) => ({
  sessionId: id, updatedAt: Date.now() - 100 * HOUR, running: false, blank: false,
  cwd: QQ_ROOT, ...over,
})

test('孤儿会话巡检：只归档 QQ 工作区里闲置够久、且没人认领的会话', async () => {
  const now = Date.now()
  const dsh = fakeDsh({
    rows: [
      // 该归档：失联的后台会话（闲置 30 小时）
      row('sess-orphan-bili', { updatedAt: now - 30 * HOUR }),
      row('sess-orphan-hot', { updatedAt: now - 30 * HOUR }),
      // 不该归档：刚用过（闲置 1 小时，没到 6 小时门槛）
      row('sess-recent', { updatedAt: now - 1 * HOUR }),
      // 不该归档：别的项目的会话（cwd 不在 QQ 工作区）
      row('sess-other-project', { updatedAt: now - 30 * HOUR, cwd: OTHER_ROOT }),
      // 不该归档：cwd 缺失 → 不猜
      row('sess-no-cwd', { updatedAt: now - 30 * HOUR, cwd: undefined }),
      // 不该归档：还在跑
      row('sess-running', { updatedAt: now - 30 * HOUR, running: true }),
      // 不该归档：空会话（草稿）
      row('sess-blank', { updatedAt: now - 30 * HOUR, blank: true }),
      // 不该归档：子智能体会话（跟着父会话走）
      row('sess-subagent', { updatedAt: now - 30 * HOUR, origin: 'subagent' }),
      row('sess-child', { updatedAt: now - 30 * HOUR, parentSessionId: 'sess-parent' }),
      // 不该归档：已归档
      row('sess-already', { updatedAt: now - 30 * HOUR }),
      // 不该归档：置顶（归档会清置顶，视为用户显式保留）
      row('sess-pinned', { updatedAt: now - 30 * HOUR }),
    ],
    archived: ['sess-already'],
    pinned: ['sess-pinned'],
  })
  const core = mkCore(dsh)

  const result = await core.sweepOrphanSessions()

  assert.equal(result.archived, 2, '只应归档两个失联的后台会话')
  assert.deepEqual(dsh.calls.map((c) => c.id).sort(), ['sess-orphan-bili', 'sess-orphan-hot'])
  for (const call of dsh.calls) {
    assert.equal(call.opts.stopActivity, true, '归档必须带 stopActivity: true，否则活动检查会静默拒绝')
  }
  // 其余 9 条全部落在 skipped 里（不是被漏掉，是被规则挡住）
  assert.equal(result.scanned, 11)
  assert.equal(result.skipped, 9)
})

test('孤儿会话巡检：聊天映射里的会话即使闲置很久也不归档（正在用）', async () => {
  const now = Date.now()
  // create 返回的正是夹具里那条会话 → 映射建立后它就等于「这个聊天正在用的会话」
  const dsh = fakeDsh({ rows: [row('sess-live-chat', { updatedAt: now - 100 * HOUR })], createId: 'sess-live-chat' })
  const core = mkCore(dsh)
  await core.registry.sessionFor('private:10000001')

  const live = Object.values(core.sessions()).map((s) => s.sessionId)
  assert.ok(live.includes('sess-live-chat'), '夹具前提：映射里确实指向这条会话')

  const result = await core.sweepOrphanSessions()
  assert.equal(result.archived, 0, '活跃映射里的会话不能被当成孤儿')
  assert.equal(dsh.calls.length, 0)
})

test('孤儿会话巡检：单轮最多归档 maxPerPass 个（防止启动后一次性改动过多）', async () => {
  const now = Date.now()
  const rows = Array.from({ length: 7 }, (_, i) => row(`sess-orphan-${i}`, { updatedAt: now - 30 * HOUR }))
  const dsh = fakeDsh({ rows })
  const core = mkCore(dsh)

  const result = await core.sweepOrphanSessions({ maxPerPass: 3 })
  assert.equal(result.archived, 3, '应该被 maxPerPass 截断')
  assert.equal(dsh.calls.length, 3)
})

test('孤儿会话巡检：宿主没有 list / archiveSession 时安静返回，不抛', async () => {
  const ctx = { on: () => () => {}, get: () => null }
  const core = createModularCore({
    dsh: ctx,
    onebot: { call: async () => ({}) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null, buildTools: () => [] },
    getConfig: () => ({ enabled: true, workspaceDir: QQ_ROOT, allow: { private: [], groups: [] } }),
    logger: noopLog,
    log: noopLog,
  })
  const result = await core.sweepOrphanSessions()
  assert.deepEqual(result, { scanned: 0, archived: 0, skipped: 0 })
})

test('孤儿会话巡检：单条归档失败不影响其余会话（且不抛出）', async () => {
  const now = Date.now()
  const dsh = fakeDsh({
    rows: [
      row('sess-bad', { updatedAt: now - 30 * HOUR }),
      row('sess-good', { updatedAt: now - 30 * HOUR }),
    ],
  })
  const reg = dsh.ctx.get('workspaceRegistry')
  const original = reg.archiveSession
  reg.archiveSession = async (id, opts) => {
    if (id === 'sess-bad') throw new Error('宿主拒绝')
    return original(id, opts)
  }
  const core = mkCore(dsh)

  const result = await core.sweepOrphanSessions()
  assert.equal(result.archived, 1)
  assert.deepEqual(dsh.calls.map((c) => c.id), ['sess-good'])
})
