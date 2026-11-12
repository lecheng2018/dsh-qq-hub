import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { workspaceDirForChat } from '../src/chat/workspace.js'
import { createDshSessionAdapter } from '../src/chat/adapters/dsh-session.js'

const root = join('/', 'tmp', 'qq-hub-workspaces')

test('工作区目录按同一配置选择：默认共用，显式开启后按聊天隔离', () => {
  assert.equal(workspaceDirForChat({ workspaceDir: root }, 'private:10001'), root)
  assert.equal(workspaceDirForChat({ workspaceDir: root, workspacePerChat: false }, 'group:20001'), root)
  assert.equal(workspaceDirForChat({ workspaceDir: root, workspacePerChat: true }, 'system:purpose'), root)
  assert.equal(workspaceDirForChat({ workspaceDir: root, workspacePerChat: true }, 'private:10001'), join(root, 'chat-private_10001'))
  assert.equal(workspaceDirForChat({ workspaceDir: root, workspacePerChat: true }, 'group:20001'), join(root, 'chat-group_20001'))
})

test('DSH 会话适配器把 chatKey 传给工作区选择并用于创建会话', async () => {
  let created
  const adapter = createDshSessionAdapter({
    dsh: {
      get: (name) => name === 'sessionController' ? {
        create: async (args) => { created = args; return { sessionId: 'session-1' } },
        resolveAgent: async () => ({}),
      } : null,
    },
    presetOf: () => ({ agentPreset: 'qq-hub-private' }),
    ensureWorkspace: (chatKey) => ({ id: workspaceDirForChat({ workspaceDir: root, workspacePerChat: true }, chatKey) }),
  })
  await adapter.createSession('private:10001')
  assert.equal(created.workspaceId, join(root, 'chat-private_10001'))
})
