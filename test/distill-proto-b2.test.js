// Batch 2 / T2.6：distill 规则库原型污染 + deepMerge 动态子对象原型污染。
// 全部用例真实调用 createDistillStore / deepMerge，不做源码正则匹配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDistillStore, isSafeGroupId, normalizeGroups } from '../extensions/distill/store.mjs'
import { deepMerge } from '../src/core/config-defaults.js'

test('T2.6：非法群号在入口被拒，绝不能污染 Object.prototype', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-distill-'))
  try {
    const store = createDistillStore(dir)
    const bad = ['__proto__', 'constructor', 'prototype', '123', '1234567890123', 'abcde']
    for (const gid of bad) assert.equal(isSafeGroupId(gid), false, `${gid} 应判非法`)
    assert.equal(isSafeGroupId('123456'), true)

    for (const method of ['clearRules', 'pruneNoise', 'consolidate']) {
      assert.throws(() => store[method]('__proto__'), /非法群号/, `${method} 必须拒绝 __proto__`)
    }
    assert.equal(Object.prototype.rules, undefined, 'Object.prototype 不能被塞进 rules')
    assert.equal({}.rules, undefined)

    // 合法群号照常工作
    store.addRules('123456', [{ situation: '被夸时', style: '谦虚' }])
    assert.equal(store.getRawRules('123456').length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('T2.6：磁盘上被写入 __proto__ 键的规则库，读回来也不会带原型链', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-distill-json-'))
  try {
    writeFileSync(join(dir, 'distill-rules.json'), JSON.stringify({
      groups: {
        __proto__: { rules: [{ id: 'x', situation: 's', style: 'y' }] },
        constructor: { rules: [] },
        654321: { rules: [{ id: 'a', situation: 's1', style: 'y1' }] },
      },
    }), 'utf8')
    const store = createDistillStore(dir)
    assert.deepEqual(store.getAllGroupIds(), ['654321'], '只有合法群号被保留')
    assert.equal(store.getRawRules('654321').length, 1)
    assert.throws(() => store.getRawRules('__proto__'), /非法群号/)
    assert.equal(Object.prototype.rules, undefined)

    // normalizeGroups 直接喂进 pollution 载荷也不产生原型链键
    const normalized = normalizeGroups(JSON.parse('{"groups":{"__proto__":{"rules":[1]}}}'))
    assert.equal(Object.getPrototypeOf(normalized.groups), null)
    assert.equal('__proto__' in normalized.groups, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('T2.6：deepMerge 递归清洗动态子对象与数组元素，且不共享可变引用', () => {
  const dirty = JSON.parse('{"ext":{"a":{"__proto__":{"polluted":true}}}}')
  const merged = deepMerge({}, dirty)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.hasOwn(merged.ext.a, '__proto__'), false)
  assert.equal(Object.getPrototypeOf(merged.ext.a), Object.prototype)

  // 数组里的纯对象元素也要清洗
  const arr = deepMerge({}, JSON.parse('{"list":[{"__proto__":{"polluted":true},"keep":1}]}'))
  assert.equal(Object.hasOwn(arr.list[0], '__proto__'), false)
  assert.equal(arr.list[0].keep, 1)
  assert.equal({}.polluted, undefined)

  // 合并结果不能与输入共享引用：改输入不能影响配置
  const over = { files: { dirs: ['/a'] } }
  const out = deepMerge({ files: { dirs: [] } }, over)
  over.files.dirs.push('/b')
  assert.deepEqual(out.files.dirs, ['/a'])
})
