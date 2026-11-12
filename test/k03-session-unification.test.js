import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('K-03B host 不再持有旧会话查询、重置、事件或模型同步回退', () => {
  assert.doesNotMatch(host, /legacyChatOfSession|legacyResetChat|legacySessions|legacyResetSessions|legacyOnSessionEvent|legacySyncAllModels/)
  assert.match(host, /hub\.sessions = \(\) => modularCoreApi\.sessions\(\)/)
  assert.match(host, /hub\.syncAllModels = \(\) => modularCoreApi\.syncAllModels\(\)/)
  assert.match(host, /hub\.chatOfSession = \(sid\) => modularCoreApi\.chatKeyOfSession\(String\(sid\)\)/)
  assert.match(host, /hub\.resetChat = \(chatId\) => modularCoreApi\.resetChat\(String\(chatId\)\)/)
  assert.match(host, /hub\.runSystemTurn = \(name, title, prompt, opts\) => modularCoreApi\.runSystemTurn\(name, title, prompt, opts\)/)
})
