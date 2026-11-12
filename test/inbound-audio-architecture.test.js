import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('入站语音由组合根持有唯一服务，新旧核心不再各自实现识别回退', () => {
  const host = source('src/host.js')
  const hub = source('src/chat/hub.js')
  const core = source('src/host/modular-core.js')
  assert.equal((host.match(/createInboundAudio\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{[\s\S]*?\binboundAudio,/)
  assert.match(host, /createModularCore\(\{[\s\S]*?\binboundAudio,/)
  assert.doesNotMatch(hub, /fetch_ptt_text|async function localTranscribe/)
  assert.doesNotMatch(core, /fetch_ptt_text|async function hydrateRecords/)
})
