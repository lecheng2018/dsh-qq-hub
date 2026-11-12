import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('审批与提问由组合根共享，效果层不再调用旧 hub 业务或会话回退', () => {
  const host = source('src/host.js')
  const effects = source('src/host/effects.js')
  assert.equal((host.match(/createQuestionRegistry\(/g) || []).length, 1)
  assert.equal((host.match(/createApprovalRegistry\(/g) || []).length, 1)
  assert.match(host, /hub = createHub\(\{[\s\S]*?\binteractions,/)
  assert.match(host, /createHostEffects\(\{[\s\S]*?\binteractions,/)
  assert.doesNotMatch(effects, /hub\.(?:requestApproval|askUserQuestion|chatOfSession)/)
})
