import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('插件面板不维护第二套管理员密钥', () => {
  assert.doesNotMatch(source, /function BridgeAccess/)
  assert.doesNotMatch(source, /qq-hub-token/)
  assert.doesNotMatch(source, /bridge\/verify/)
  assert.doesNotMatch(source, /联动与管理员密钥/)
  assert.doesNotMatch(source, /修改或重置密码需要联动密钥/)
})
