import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
const facade = readFileSync(new URL('../src/host/current-hub.js', import.meta.url), 'utf8')

test('K-03C 生产装配不再创建旧 hub、管道或读取旧灰度开关', () => {
  assert.doesNotMatch(host, /createHub\(|assemblePipeline|createLegacyHubFallback|isPipelineEnabled|isModularCoreEnabled|FLAG_USE_PIPELINE|FLAG_MODULAR_CORE/)
  assert.doesNotMatch(host, /chat\/hub\.js|host\/pipeline\.js|kernel\/legacy-fallback\.js/)
})

test('K-03C 模块只获得当前服务的冻结窄 facade', () => {
  assert.match(facade, /Object\.freeze\(/)
  assert.doesNotMatch(facade, /createHub|chat\/hub\.js|sessions\.json/)
})
