// 回归（P1-2）：全局 3000 上限 → 按作用域独立配额，淘汰留日志，任何作用域不被整段清空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evictScopeItems, quotaForScope, SCOPE_QUOTAS } from '../src/features/memory.js'

test('配额：global 500 / 单群 400 / 单私聊 300', () => {
  assert.equal(quotaForScope('global'), 500)
  assert.equal(quotaForScope('group:1'), 400)
  assert.equal(quotaForScope('private:2'), 300)
  assert.equal(quotaForScope(''), 500, '空/未知 scope 归 global 桶')
})

test('超配额淘汰：低重要度先走，auto 来源优先于 tool', () => {
  const items = []
  for (let i = 0; i < 310; i++) {
    items.push({ id: 'p' + i, scope: 'private:9', importance: 0.5, source: i % 2 ? 'tool' : 'auto', at: 1000 + i, text: 't' + i })
  }
  // 把 10 条标成低重要度 tool —— 这 10 条必被淘汰（importance 主键）
  for (let i = 0; i < 10; i++) items[i].importance = 0.1
  const removed = evictScopeItems(items, 'private:9', 300)
  assert.equal(removed, 10)
  assert.ok(!items.find((m) => m.id === 'p0'), '低重要度被裁')
  assert.equal(items.filter((m) => m.scope === 'private:9').length, 300)
})

test('其他作用域不受影响（不会被整段清空）', () => {
  const items = []
  for (let i = 0; i < 350; i++) items.push({ id: 'g' + i, scope: 'group:1', importance: 0.9, source: 'tool', at: i })
  for (let i = 0; i < 10; i++) items.push({ id: 'x' + i, scope: 'private:9', importance: 0.1, source: 'auto', at: i })
  const removed = evictScopeItems(items, 'group:1', 400)
  assert.equal(removed, 0)
  assert.equal(items.filter((m) => m.scope === 'group:1').length, 350, '没超配额不动')
  assert.equal(items.filter((m) => m.scope === 'private:9').length, 10, '别的域不牵连')
})
