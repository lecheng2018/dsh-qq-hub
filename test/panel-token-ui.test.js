import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('联动面板提供密钥输入、校验和开关，不回显明文', () => {
  assert.match(source, /function BridgeAccess/)
  assert.match(source, /联动与管理员密钥/)
  assert.match(source, /qq-hub-token/)
  assert.match(source, /bridge\/verify/)
  assert.match(source, /校验密钥/)
  assert.match(source, /只保存在当前标签页/)
})
