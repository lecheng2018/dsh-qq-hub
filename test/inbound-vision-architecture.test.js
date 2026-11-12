import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('辅助视觉由组合根共享，modular 在附件登记前使用同一降级服务', () => {
  const host = source('src/host.js')
  const hub = source('src/chat/hub.js')
  const core = source('src/host/modular-core.js')
  assert.equal((host.match(/createInboundVision\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{/)
  assert.match(host, /createModularCore\(\{[\s\S]*?\binboundVision,/)
  assert.doesNotMatch(hub, /async function imageTextFor/)
  assert.match(core, /inboundVision\.admit\(content,/)
})
