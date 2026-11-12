import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('近期媒体由组合根持有唯一实例，新核心不再回写旧 hub', () => {
  const host = source('src/host.js')
  const hub = source('src/chat/hub.js')
  assert.equal((host.match(/createRecentMedia\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{[\s\S]*?\brecentMedia,/)
  assert.match(host, /noteMedia: \(chatKey, segments, userId\).*recentMedia\.rememberSegments\(chatKey, segments, userId\)/)
  assert.doesNotMatch(host, /hub\.noteRecentMedia/)
  assert.match(hub, /recentMedia: sharedRecentMedia/)
  assert.match(hub, /sharedRecentMedia \|\| createRecentMedia/)
})
