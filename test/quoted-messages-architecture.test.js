import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('引用读取由组合根持有唯一服务，当前核心不维护重复请求与缓存', () => {
  const host = source('src/host.js')
  const hub = source('src/host/current-hub.js')
  const core = source('src/host/modular-core.js')
  assert.equal((host.match(/createQuotedMessages\(/g) || []).length, 1)
  assert.match(host, /createModularCore\(\{[\s\S]*?\bquotedMessages,/)
  assert.match(host, /createModularCore\(\{[\s\S]*?\bquotedMessages,/)
  for (const implementation of [hub, core]) {
    assert.doesNotMatch(implementation, /quoteCache|quoteFromHistory|async function quotedInfo/)
  }
})
