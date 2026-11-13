import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('近期媒体由组合根持有唯一实例，当前 facade 只转发该服务', () => {
  const host = source('src/host.js')
  const hub = source('src/host/current-hub.js')
  assert.equal((host.match(/createRecentMedia\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{[\s\S]*?\brecentMedia,/)
  assert.match(host, /noteMedia: \(chatKey, segments, userId\).*recentMedia\.rememberSegments\(chatKey, segments, userId\)/)
  assert.doesNotMatch(host, /hub\.noteRecentMedia/)
  assert.match(hub, /recentMedia: \(chatId, userId\) => recentMedia\.get\(chatId, userId\)/)
  assert.match(hub, /noteRecentMedia:.*recentMedia\.rememberSegments/)
  assert.doesNotMatch(hub, /createRecentMedia/)
})
