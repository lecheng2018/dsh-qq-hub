// 目的引擎的面板设置：
// 1) 引擎真正读取的字段，面板上必须有入口（曾经删掉手写卡后丢了投递载体等四项）
// 2) settings 的 type 必须是面板 field() 认识的类型
//    —— 面板只认 switch/number/select/textarea/password/text，写 boolean 会退化成文本框
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PURPOSE = readFileSync(join(process.cwd(), 'src', 'modules', 'purpose', 'index.js'), 'utf8')
const CLIENT = readFileSync(join(process.cwd(), 'client', 'client.js'), 'utf8')

/** 面板 field() 真正支持的 type */
const RENDERABLE = new Set(['switch', 'number', 'select', 'textarea', 'password', 'text'])

function settingKeys(src) {
  const block = src.slice(src.indexOf('settings: ['), src.indexOf('setup(api)'))
  return [...block.matchAll(/key:\s*'([a-zA-Z]+)'/g)].map((m) => m[1])
}

function settingTypes(src) {
  const block = src.slice(src.indexOf('settings: ['), src.indexOf('setup(api)'))
  return [...block.matchAll(/key:\s*'([a-zA-Z]+)'[^}]*?type:\s*'([a-zA-Z]+)'/g)].map((m) => [m[1], m[2]])
}

test('引擎读取的字段，面板都要有入口', () => {
  const keys = settingKeys(PURPOSE)
  for (const need of ['enabled', 'minMaterials', 'initialDelayMinutes', 'maxCandidates']) {
    assert.ok(keys.includes(need), `核心设置 ${need} 不见了`)
  }
  // 这四项是删掉手写卡后必须补回来的
  for (const need of ['carrier', 'petFallbackToQQ', 'maxPerDay']) {
    assert.ok(keys.includes(need), `投递相关设置 ${need} 缺入口，引擎在读但改不了`)
  }
})

test('所有 settings 的 type 都是面板认得的（写 boolean 会退化成文本框）', () => {
  for (const [key, type] of settingTypes(PURPOSE)) {
    assert.ok(RENDERABLE.has(type), `设置 ${key} 的 type='${type}' 面板不认识，请改成 switch/text 等`)
  }
})

test('面板的 field() 确实不处理 boolean（守住上面那条判断的依据）', () => {
  assert.ok(!/s\.type === 'boolean'/.test(CLIENT), '面板开始支持 boolean 了，这条测试的前提需要更新')
})

test('模块 defaults 覆盖了 carrier / petFallbackToQQ / maxPerDay，面板才有初值', () => {
  const d = PURPOSE.slice(PURPOSE.indexOf('defaults: {'), PURPOSE.indexOf('settings: ['))
  assert.match(d, /carrier:\s*'qq'/)
  assert.match(d, /petFallbackToQQ:\s*true/)
  assert.match(d, /maxPerDay:\s*\d+/)
})

test('引擎侧真的在读这三个字段（不是摆设）', () => {
  const mod = readFileSync(join(process.cwd(), 'src', 'purpose', 'module.js'), 'utf8')
  assert.match(mod, /ext\.carrier/, 'carrier 没被读取')
  assert.match(mod, /petFallbackToQQ/, 'petFallbackToQQ 没被读取')
  assert.match(mod, /ext\.maxPerDay/, 'maxPerDay 没被读取')
})
