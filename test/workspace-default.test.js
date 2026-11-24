// 默认工作区：1.4.8 起从 ~/Aurabot/qq-chats 换成 ~/QQ Hub/qq-chats，
// 老安装（老目录还在、面板没填过路径）启动时整体改名带过来，改不动就继续用老位置。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_WORKSPACE, LEGACY_WORKSPACES, WORKSPACE_DIR,
  activateWorkspaceDir, migrateLegacyWorkspace, pickWorkspaceDir, planWorkspaceMigration,
  workspaceDirForChat, workspaceDirOf,
} from '../src/chat/workspace.js'

const NEW_DIR = join(homedir(), 'QQ Hub', 'qq-chats')
const OLD_DIR = join(homedir(), 'Aurabot', 'qq-chats')

const existsOnly = (...dirs) => (p) => dirs.includes(p)

test('workspace: 默认位置是用户目录下 QQ Hub/qq-chats', () => {
  assert.equal(DEFAULT_WORKSPACE, NEW_DIR)
  assert.equal(LEGACY_WORKSPACES[0], OLD_DIR)
  assert.equal(pickWorkspaceDir({ env: {}, exists: () => false }), NEW_DIR)
})

test('workspace: 环境变量优先于目录探测，QQ_HUB_WORKSPACE 压过老名字', () => {
  assert.equal(pickWorkspaceDir({ env: { QQ_HUB_WORKSPACE: '/from/new', AURABOT_WORKSPACE: '/from/old' }, exists: () => false }), '/from/new')
  assert.equal(pickWorkspaceDir({ env: { AURABOT_WORKSPACE: '  /from/old  ' }, exists: () => false }), '/from/old')
  assert.equal(pickWorkspaceDir({ env: { QQ_HUB_WORKSPACE: '   ' }, exists: () => true }), NEW_DIR, '空字符串算没填')
})

test('workspace: 已经手动搬过就认新目录，只在老目录时才回退（别把历史会话丢在新的空目录里）', () => {
  assert.equal(pickWorkspaceDir({ env: {}, exists: existsOnly(NEW_DIR, OLD_DIR) }), NEW_DIR)
  assert.equal(pickWorkspaceDir({ env: {}, exists: existsOnly(OLD_DIR) }), OLD_DIR)
})

test('workspace: 迁移计划——面板填了路径或给了环境变量的人一律不动', () => {
  assert.deepEqual(planWorkspaceMigration({ workspaceDir: '/custom/dir' }, { env: {}, exists: existsOnly(OLD_DIR) }), { move: false, reason: 'configured' })
  assert.deepEqual(planWorkspaceMigration({}, { env: { QQ_HUB_WORKSPACE: '/env/dir' }, exists: existsOnly(OLD_DIR) }), { move: false, reason: 'env' })
  assert.deepEqual(planWorkspaceMigration({}, { env: {}, exists: () => false }), { move: false, reason: 'no-legacy' })
  assert.deepEqual(planWorkspaceMigration({}, { env: {}, exists: existsOnly(OLD_DIR, NEW_DIR) }), { move: false, reason: 'target-exists' })
  assert.deepEqual(planWorkspaceMigration({}, { env: {}, exists: existsOnly(OLD_DIR) }), { move: true, from: OLD_DIR, to: NEW_DIR, reason: 'legacy' })
})

test('workspace: 迁移成功会把老目录整个改名，并让本次运行立刻用新位置', () => {
  const before = WORKSPACE_DIR
  const calls = []
  try {
    const out = migrateLegacyWorkspace({}, {
      env: {},
      exists: existsOnly(OLD_DIR),
      mkdir: (dir, opts) => calls.push(['mkdir', dir, opts?.recursive]),
      rename: (from, to) => calls.push(['rename', from, to]),
    })
    assert.deepEqual(out, { moved: true, from: OLD_DIR, to: NEW_DIR, reason: 'migrated' })
    assert.deepEqual(calls, [['mkdir', join(homedir(), 'QQ Hub'), true], ['rename', OLD_DIR, NEW_DIR]])
    assert.equal(workspaceDirOf({}), NEW_DIR)
    assert.equal(workspaceDirOf({ workspaceDir: '/custom/dir' }), '/custom/dir', '面板里填的还是最优先')
  } finally {
    activateWorkspaceDir(before)
  }
})

test('workspace: 改名失败（跨盘/被占用）不复制不删除，退回老位置继续跑', () => {
  const before = WORKSPACE_DIR
  const warned = []
  try {
    const out = migrateLegacyWorkspace({}, {
      env: {},
      exists: existsOnly(OLD_DIR),
      mkdir: () => {},
      rename: () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }) },
      log: { warn: (msg) => warned.push(msg) },
    })
    assert.equal(out.moved, false)
    assert.equal(out.reason, 'rename-failed')
    assert.match(out.error, /EXDEV/)
    assert.equal(workspaceDirOf({}), before, '没搬成就别改生效目录')
    assert.equal(warned.length, 1)
    assert.match(warned[0], /继续用老的/)
  } finally {
    activateWorkspaceDir(before)
  }
})

test('workspace: 老目录已经在 DSH 里登记成工作区就不改名（旧会话还挂在那条记录上）', () => {
  const before = WORKSPACE_DIR
  const calls = []
  const notes = []
  try {
    const out = migrateLegacyWorkspace({}, {
      env: {},
      exists: existsOnly(OLD_DIR),
      isRegistered: (dir) => dir === OLD_DIR,
      mkdir: () => calls.push('mkdir'),
      rename: () => calls.push('rename'),
      log: { info: (msg) => notes.push(msg) },
    })
    assert.deepEqual(out, { moved: false, from: OLD_DIR, to: NEW_DIR, reason: 'registered' })
    assert.deepEqual(calls, [], '一次 mkdir / rename 都不该做')
    assert.equal(workspaceDirOf({}), before)
    assert.match(notes[0], /已经登记过/)
  } finally {
    activateWorkspaceDir(before)
  }
})

test('workspace: 面板填了路径时迁移直接跳过，一次磁盘操作都不做', () => {
  const calls = []
  const out = migrateLegacyWorkspace({ workspaceDir: '/custom/dir' }, {
    env: {},
    exists: () => { calls.push('exists'); return true },
    mkdir: () => calls.push('mkdir'),
    rename: () => calls.push('rename'),
  })
  assert.deepEqual(out, { moved: false, reason: 'configured' })
  assert.deepEqual(calls, [], '面板填了路径就直接返回，连目录探测都不该做')
})

test('workspace: 每会话子目录仍然挂在根目录下', () => {
  const root = workspaceDirOf({})
  assert.equal(workspaceDirForChat({ workspacePerChat: true }, 'group:123'), join(root, 'chat-group_123'))
  assert.equal(workspaceDirForChat({ workspacePerChat: false }, 'group:123'), root)
})
