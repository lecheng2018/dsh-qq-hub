import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceDirOf, WORKSPACE_DIR, WORKSPACE_TITLE } from '../src/chat/workspace.js'
import { visibleScopes, isVisible, scopeOf } from '../src/features/memory-scope.js'

test('workspace: 纯工具正常读取配置与默认值', () => {
  assert.equal(WORKSPACE_TITLE, 'QQ Hub')
  assert.equal(workspaceDirOf(null), WORKSPACE_DIR)
  assert.equal(workspaceDirOf({}), WORKSPACE_DIR)
  assert.equal(workspaceDirOf({ workspaceDir: '/custom/dir' }), '/custom/dir')
})

test('memory-scope: 作用域纯函数计算与隔离口径', () => {
  // scopeOf
  assert.equal(scopeOf(null), 'global')
  assert.equal(scopeOf({ kind: 'system' }), 'global')
  assert.equal(scopeOf({ kind: 'private', userId: '10001' }), 'private:10001')
  assert.equal(scopeOf({ kind: 'group', groupId: '20001' }), 'group:20001')
  assert.equal(scopeOf({ kind: 'unknown' }), 'private:unknown')

  // visibleScopes
  assert.deepEqual(visibleScopes(null), [])
  assert.deepEqual(visibleScopes({ kind: 'system' }), [])
  assert.deepEqual(visibleScopes({ kind: 'private', userId: '10001' }), ['private:10001', 'global'])
  assert.deepEqual(visibleScopes({ kind: 'group', groupId: '20001' }), ['group:20001', 'global'])

  // isVisible
  assert.equal(isVisible(null, { kind: 'private', userId: '10001' }), false)
  assert.equal(isVisible({ scope: '' }, { kind: 'private', userId: '10001' }), false)
  assert.equal(isVisible({ scope: 'global' }, { kind: 'private', userId: '10001' }), true)
  assert.equal(isVisible({ scope: 'private:10001' }, { kind: 'private', userId: '10001' }), true)
  assert.equal(isVisible({ scope: 'private:10002' }, { kind: 'private', userId: '10001' }), false)
  assert.equal(isVisible({ scope: 'group:20001' }, { kind: 'private', userId: '10001' }), false)
  assert.equal(isVisible({ scope: 'global' }, { kind: 'system' }), false, 'system 会话不看分层记忆')
})
