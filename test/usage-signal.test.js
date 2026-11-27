// 回归（1.3.29）：用量遥测面板功能移除后，token-guardian 的压缩判定仍要拿到真实用量。
// 做法：host 把 assistant/message 的 usage 以 session/usage 事件转发给模块（纯内存，不落盘）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// host.js 分层拆分后：会话事件监听在 host/effects.js（断言逐字保留）
const HOST = readFileSync(join(ROOT, 'src/host/effects.js'), 'utf8')
const HOST_MAIN = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
const BILLING = readFileSync(join(ROOT, 'src/modules/token-billing/index.js'), 'utf8')

test('host 把 assistant/message 的 usage 转发为 session/usage 事件', () => {
  assert.match(HOST, /event\.type === 'assistant\/message'/, '盯 assistant/message')
  assert.match(HOST, /mods\.emit\('session\/usage'/, '转发给模块')
  assert.ok(!/createTelemetry/.test(HOST) && !/createTelemetry/.test(HOST_MAIN), '遥测核心不再回来')
})

test('token-billing 监听 session/usage 统计真实用量', () => {
  assert.match(BILLING, /api\.on\('session\/usage'/, '挂监听')
  assert.ok(!/addEventListener/.test(BILLING))
})
