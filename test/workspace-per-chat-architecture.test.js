import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('当前核心通过共享纯函数选择聊天工作区', () => {
  const core = source('src/host/modular-core.js')
  const adapter = source('src/chat/adapters/dsh-session.js')
  assert.match(core, /workspaceDirForChat\(getConfig\(\), chatKey\)/)
  assert.match(adapter, /ensureWorkspace\(chatKey\)/)
  assert.doesNotMatch(core, /const dir = workspaceDirOf\(getConfig\(\)\)/)
})
