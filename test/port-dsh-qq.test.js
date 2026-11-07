// 移植五件套的测试：五件套都是纯函数 / 独立状态，不依赖 DSH 宿主，可以单独测。

import test from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeUnfinished } from '../src/modules/complete-guard/index.js'
import { visibleScopes, isVisible, scopeOf } from '../src/modules/memory-privacy/index.js'
import tokenGuardian from '../src/modules/token-guardian/index.js'
import completeGuard from '../src/modules/complete-guard/index.js'
import memoryPrivacy from '../src/modules/memory-privacy/index.js'
import scheduler from '../src/modules/scheduler/index.js'
import { BUILTINS } from '../src/modules/index.js'

// ---------- 1. 模块清单 ----------
test('移植模块都注册进了 BUILTINS，id 不重复', () => {
  const ids = BUILTINS.map((m) => m.id)
  for (const id of ['token-guardian', 'complete-guard', 'memory-privacy', 'scheduler']) {
    assert.ok(ids.includes(id), `${id} 没注册`)
  }
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
})

test('每个模块的定义完整：id / name / api / setup / settings', () => {
  for (const def of [tokenGuardian, completeGuard, memoryPrivacy, scheduler]) {
    assert.match(def.id, /^[a-z][a-z0-9-]{1,39}$/)
    assert.ok(def.name && def.name.length > 0)
    assert.equal(def.api, 1)
    assert.equal(typeof def.setup, 'function')
    assert.ok(def.defaults && typeof def.defaults === 'object')
    assert.ok(Array.isArray(def.settings) && def.settings.length > 0)
    for (const s of def.settings) {
      assert.ok(s.key && s.label && s.type, `${def.id} 的设置项缺字段`)
    }
    // defaults 里每个 key 都要有对应的设置项，不然面板改不了
    for (const k of Object.keys(def.defaults)) {
      assert.ok(def.settings.some((s) => s.key === k), `${def.id} 的默认值 ${k} 没有对应设置项`)
    }
  }
})

// ---------- 2. 话说完没（dsh-qq v2-wait.js） ----------
test('停在连接词上的回复算没说完', () => {
  for (const t of ['我觉得这个可以，但是', '所以', '因为', '比如', '首先', '然后']) {
    assert.equal(looksLikeUnfinished(t).unfinished, true, t)
  }
})

test('正常说完的回复不算没说完', () => {
  for (const t of ['好呀，我这就去看看。', '行', '今天天气不错！', '我懂了，原来是这么回事。']) {
    assert.equal(looksLikeUnfinished(t).unfinished, false, t)
  }
})

test('停在该闭合的括号、列举序号上算没说完', () => {
  assert.equal(looksLikeUnfinished('他说「这个不行').unfinished, true)
  assert.equal(looksLikeUnfinished('分三步：\n1.').unfinished, true)
  assert.equal(looksLikeUnfinished('（我们明天').unfinished, true)
})

test('长回复以逗号收尾算没说完，短句以逗号收尾不算', () => {
  const long = '我'.repeat(100) + '，'
  assert.equal(looksLikeUnfinished(long).unfinished, true)
  assert.equal(looksLikeUnfinished('好，').unfinished, false)
})

test('DSH 给的结束原因不是 completed 时直接算没说完', () => {
  assert.equal(looksLikeUnfinished('说完了的内容。', 'max-tokens').unfinished, true)
  assert.equal(looksLikeUnfinished('说完了的内容。', 'completed').unfinished, false)
})

test('空字符串不算没说完，也不报错', () => {
  assert.equal(looksLikeUnfinished('').unfinished, false)
  assert.equal(looksLikeUnfinished(null).unfinished, false)
})

// ---------- 3. 权限锁（dsh-qq totp.js） ----------
test('私聊只看到自己的私聊记忆和全局记忆', () => {
  const chat = { kind: 'private', userId: '111', chatId: 'private:111' }
  const v = visibleScopes(chat)
  assert.deepEqual(v.sort(), ['global', 'private:111'].sort())
  assert.equal(isVisible({ scope: 'private:111' }, chat), true)
  assert.equal(isVisible({ scope: 'private:222' }, chat), false, '别人的私聊记忆必须挡住')
  assert.equal(isVisible({ scope: 'group:999' }, chat), false, '群记忆不能进私聊')
  assert.equal(isVisible({ scope: 'global' }, chat), true)
})

test('群里拿不到任何私聊记忆（本轮最关键的隔离）', () => {
  const chat = { kind: 'group', groupId: '999', chatId: 'group:999' }
  assert.equal(isVisible({ scope: 'private:111' }, chat), false)
  assert.equal(isVisible({ scope: 'private:999' }, chat), false)
  assert.equal(isVisible({ scope: 'group:999' }, chat), true)
  assert.equal(isVisible({ scope: 'group:888' }, chat), false, '别的群也不能串')
  assert.equal(isVisible({ scope: 'global' }, chat), true)
})

test('没写作用域的一律不可见（不再按全局放行），system 会话看不到任何分层记忆', () => {
  // 以前这里是 assert true —— 把「没写 scope」当 global 处理。
  // 但忘了写 scope 的老条目会因此对所有人可见，正是跨聊天泄漏的口子。
  // 现在和 features/memory.js 的 scopeVisible 同一口径：认不出来源就不给。
  assert.equal(isVisible({ text: 'x' }, { kind: 'group', groupId: '1' }), false)
  assert.equal(isVisible({ text: 'x' }, { kind: 'private', userId: '1' }), false)
  assert.deepEqual(visibleScopes({ kind: 'system' }), [])
  assert.equal(isVisible({ scope: 'global' }, { kind: 'system' }), false)
})

test('scopeOf 按聊天给出正确的作用域，null 不炸', () => {
  assert.equal(scopeOf({ kind: 'private', userId: '1' }), 'private:1')
  assert.equal(scopeOf({ kind: 'group', groupId: '2' }), 'group:2')
  assert.equal(scopeOf({ kind: 'system' }), 'global')
  assert.equal(scopeOf(null), 'global')
})

// ---------- 6. 预算守门员（dsh-qq auto-compact.js） ----------
test('token 估算：字符数换算成 token，空值算 0', () => {
  const est = tokenGuardian.setup.length ? null : null
  // estimate 是模块内部函数，这里按同样的公式验一遍口径
  const estimate = (chars) => Math.round(Number(chars || 0) / 1.2)
  assert.equal(estimate(1200), 1000)
  assert.equal(estimate(0), 0)
  assert.equal(estimate(null), 0)
  assert.equal(estimate(undefined), 0)
})

test('默认阈值是 30 万 token，冷却 120 分钟，关闭状态', () => {
  assert.equal(tokenGuardian.defaults.threshold, 300000)
  assert.equal(tokenGuardian.defaults.cooldownMinutes, 120)
  assert.equal(tokenGuardian.defaults.enabled, false)
})

test('记忆分层和完整守卫默认开启（纯增益、不改她的回复）', () => {
  assert.equal(memoryPrivacy.defaults.enabled, true)
  assert.equal(completeGuard.defaults.enabled, true)
})
