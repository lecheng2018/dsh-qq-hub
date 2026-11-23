// 验证重置所有会话时全量扫描并归档 QQ 工作区孤儿会话，且传 stopActivity: true
import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'
import { createCurrentHub } from '../src/host/current-hub.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

test('resetSessions: 全量扫描 QQ 工作区孤儿会话并传 stopActivity: true 归档', async () => {
  const archivedRecords = []
  const archivedIds = new Set(['sess-already-archived'])
  const workspaces = [
    {
      id: 'ws-qq',
      path: '/tmp/test-qq-workspace',
      sessionIds: ['sess-live-1', 'sess-orphan-bili', 'sess-orphan-hot', 'sess-already-archived'],
    },
    {
      id: 'ws-other',
      path: '/tmp/other-workspace',
      sessionIds: ['sess-other-1'],
    },
  ]

  let sessionCount = 0
  const ctrl = {
    create: async () => {
      sessionCount++
      const id = `sess-live-${sessionCount}`
      return { sessionId: id }
    },
    resolveAgent: async (id) => ({ agent: { followup: async () => {} } }),
  }

  const dsh = {
    on: () => () => {},
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          get archivedSessionIds() { return Array.from(archivedIds) },
          archiveSession: async (id, opts = {}) => {
            archivedRecords.push({ id, opts })
            archivedIds.add(id)
          },
        }
      }
      return null
    },
  }

  const cfg = {
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] },
    workspaceDir: '/tmp/test-qq-workspace',
  }

  const modular = createModularCore({
    dsh,
    onebot: { call: async () => ({}) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null, buildTools: () => [] },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
  })

  // 模拟一个活跃会话登记在 registry
  modular.registry.save?.('private:10000001', { sessionId: 'sess-live-1' })

  const hub = createCurrentHub({
    modular,
    services: {},
    interactions: { approvals: { clear() {} }, questions: { cancel() {} } },
    log: noopLog,
    logChat: () => {},
  })

  const count = hub.resetSessions()
  await new Promise((r) => setTimeout(r, 10))

  // 验证归档总数包含孤儿会话
  assert.ok(count >= 3, `至少应归档 3 个会话（sess-live-1, sess-orphan-bili, sess-orphan-hot），实际 ${count}`)

  // 验证孤儿会话确实被归档
  const archivedIdList = archivedRecords.map((r) => r.id)
  assert.ok(archivedIdList.includes('sess-orphan-bili'), '应归档 sess-orphan-bili')
  assert.ok(archivedIdList.includes('sess-orphan-hot'), '应归档 sess-orphan-hot')
  assert.ok(archivedIdList.includes('sess-live-1'), '应归档活跃会话 sess-live-1')

  // 验证不属于 QQ 工作区的会话没有被误归档
  assert.ok(!archivedIdList.includes('sess-other-1'), '不应归档其他工作区的 sess-other-1')

  // 验证所有归档调用都带上了 stopActivity: true
  for (const record of archivedRecords) {
    assert.equal(record.opts.stopActivity, true, `${record.id} 归档应携带 stopActivity: true`)
  }
})
