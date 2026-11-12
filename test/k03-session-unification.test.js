import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
const facade = readFileSync(new URL('../src/host/current-hub.js', import.meta.url), 'utf8')

test('K-03B host 不再持有旧会话查询、重置、事件或模型同步回退', () => {
  assert.doesNotMatch(host, /legacyChatOfSession|legacyResetChat|legacySessions|legacyResetSessions|legacyOnSessionEvent|legacySyncAllModels/)
  assert.match(facade, /sessions: modular\.sessions/)
  assert.match(facade, /syncAllModels: modular\.syncAllModels/)
  assert.match(facade, /chatOfSession: modular\.chatKeyOfSession/)
  assert.match(facade, /resetChat: modular\.resetChat/)
  assert.match(facade, /runSystemTurn: modular\.runSystemTurn/)
})
