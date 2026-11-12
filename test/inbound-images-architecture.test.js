import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('入站图片与附件登记由组合根共享，新旧核心不再各自实现', () => {
  const host = source('src/host.js')
  const hub = source('src/chat/hub.js')
  const core = source('src/host/modular-core.js')
  assert.equal((host.match(/createInboundImages\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{/)
  assert.match(host, /createModularCore\(\{[\s\S]*?\binboundImages,/)
  assert.doesNotMatch(hub, /async function imagesOf/)
  assert.doesNotMatch(core, /async function admitContent/)
})
