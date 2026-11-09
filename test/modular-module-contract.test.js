import test from 'node:test'
import assert from 'node:assert/strict'

import { validateModuleContract } from '../src/core/module-contract.js'

function definition(overrides = {}) {
  return {
    id: 'example-module',
    name: 'Example',
    version: '1.0.0',
    setup() {},
    ...overrides,
  }
}

test('旧版模块定义无需新字段即可通过兼容校验', () => {
  const legacy = definition()
  const normalized = validateModuleContract(legacy)
  assert.equal(normalized.api, 1)
  assert.deepEqual(normalized.provides, [])
  assert.deepEqual(normalized.requires, [])
  assert.deepEqual(normalized.conflicts, [])
  assert.equal(legacy.api, undefined)
  assert.equal(legacy.provides, undefined)
})

test('模块可声明抽象能力、依赖、冲突和默认启停', () => {
  const normalized = validateModuleContract(definition({
    api: 1,
    provides: ['memory-store'],
    requires: ['outbox'],
    conflicts: ['legacy-memory'],
    defaultEnabled: false,
    requiresGUI: false,
    configVersion: 2,
    storageVersion: 3,
  }))
  assert.equal(normalized.provides[0], 'memory-store')
  assert.equal(normalized.requires[0], 'outbox')
  assert.equal(normalized.defaultEnabled, false)
  assert.equal(normalized.configVersion, 2)
  assert.equal(normalized.storageVersion, 3)
})

test('模块 ID 沿用现有内核规则', () => {
  for (const id of ['', 'A', '1module', 'a', 'bad_name']) {
    assert.throws(() => validateModuleContract(definition({ id })), /id/)
  }
})

test('API 和 schema 版本必须是正整数', () => {
  for (const field of ['api', 'configVersion', 'storageVersion']) {
    for (const value of [0, -1, 1.5, '1']) {
      assert.throws(() => validateModuleContract(definition({ [field]: value })), new RegExp(field))
    }
  }
})

test('能力列表必须唯一且不能自依赖或自冲突', () => {
  assert.throws(() => validateModuleContract(definition({ provides: ['memory', 'memory'] })), /重复/)
  assert.throws(() => validateModuleContract(definition({ provides: ['memory'], requires: ['memory'] })), /同时/)
  assert.throws(() => validateModuleContract(definition({ id: 'memory', conflicts: ['memory'] })), /自身/)
  assert.throws(() => validateModuleContract(definition({ provides: 'memory' })), /provides/)
})

test('默认开关和 GUI 声明只接受布尔值', () => {
  for (const field of ['defaultEnabled', 'requiresGUI']) {
    assert.throws(() => validateModuleContract(definition({ [field]: 'false' })), new RegExp(field))
  }
})

test('缺少 setup 或版本时给出可诊断错误', () => {
  assert.throws(() => validateModuleContract(definition({ setup: null })), /setup/)
  assert.throws(() => validateModuleContract(definition({ version: '' })), /version/)
})

test('当前全部内置模块无需修改即可满足兼容契约', async () => {
  const { BUILTINS } = await import('../src/modules/index.js')
  assert.ok(BUILTINS.length > 0)
  for (const module of BUILTINS) {
    assert.equal(validateModuleContract(module).id, module.id)
  }
})
