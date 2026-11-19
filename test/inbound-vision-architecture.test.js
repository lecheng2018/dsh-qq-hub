import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('辅助视觉由组合根共享，modular 在附件登记前使用同一降级服务', () => {
  const host = source('src/host.js')
  const hub = source('src/host/current-hub.js')
  const core = source('src/host/modular-core.js')
  assert.equal((host.match(/createInboundVision\(/g) || []).length, 1)
  assert.match(host, /hub = createCurrentHub\(\{/)
  assert.match(host, /createModularCore\(\{[\s\S]*?\binboundVision,/)
  assert.doesNotMatch(hub, /async function imageTextFor/)
  // 核心把内容交给共享视觉服务（降级/转述都归它）；中间可能先过一层图片预算闸，
  // 所以只锁「admit 的入参来自本核心处理过的内容」，不锁变量名。
  assert.match(core, /inboundVision\.admit\(\s*(?:content|trimmed)\s*,/)
})
