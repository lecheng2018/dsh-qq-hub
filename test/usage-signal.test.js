// 回归（1.3.29）：用量遥测面板功能移除后，token-guardian 的压缩判定仍要拿到真实用量。
// 做法：host 把 assistant/message 的 usage 以 session/usage 事件转发给模块（纯内存，不落盘）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
// host.js 分层拆分后：会话事件监听在 host/effects.js（断言逐字保留）
const HOST = readFileSync(join(ROOT, 'src/host/effects.js'), 'utf8')
const HOST_MAIN = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
const TG = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')

test('host 把 assistant/message 的 usage 转发为 session/usage 事件', () => {
  assert.match(HOST, /event\.type === 'assistant\/message'/, '盯 assistant/message')
  assert.match(HOST, /mods\.emit\('session\/usage'/, '转发给模块')
  assert.ok(!/createTelemetry/.test(HOST) && !/createTelemetry/.test(HOST_MAIN), '遥测核心不再回来')
})

test('token-guardian 监听 session/usage 并用真实值判定', () => {
  assert.match(TG, /api\.on\('session\/usage'/, '挂监听')
  assert.match(TG, /latestByChat\.get\(key\)/, 'tickOnce 判定读真实值')
  assert.match(TG, /latestByChat\.get\(chatId\)/, '面板状态读真实值')
  assert.match(TG, /ctxNow < prevTok \* 0\.6/, '小请求噪音不覆盖大值')
  assert.match(TG, /latestByChat\.delete\(String\(chatId/, '压缩后清掉旧值防反复压')
  // 事件监听要能随模块停掉自动注销：必须用 api.on（有 track），不是裸 addEventListener
  assert.ok(!/addEventListener/.test(TG))
})

test('监听容错：坏数据不抛', () => {
  // 纯逻辑复核：n() 对负数/非数字归 0，ctxNow<=0 直接 return
  assert.match(TG, /Number\.isFinite\(v\) && v > 0 \? v : 0/, '字段归一化')
  assert.match(TG, /if \(ctxNow <= 0\) return/, '全 0 跳过')
})
