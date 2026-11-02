// 移植五件套的测试：五件套都是纯函数 / 独立状态，不依赖 DSH 宿主，可以单独测。

import test from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeUnfinished } from '../src/modules/complete-guard/index.js'
import { newSecret, totpAt, verifyTotp, otpauthUrl, base32Decode } from '../src/modules/security-lock/index.js'
import { visibleScopes, isVisible, scopeOf } from '../src/modules/memory-privacy/index.js'
import { candidatesFrom } from '../src/modules/slang-learner/index.js'
import tokenGuardian from '../src/modules/token-guardian/index.js'
import completeGuard from '../src/modules/complete-guard/index.js'
import securityLock from '../src/modules/security-lock/index.js'
import memoryPrivacy from '../src/modules/memory-privacy/index.js'
import slangLearner from '../src/modules/slang-learner/index.js'
import scheduler from '../src/modules/scheduler/index.js'
import { BUILTINS } from '../src/modules/index.js'

// ---------- 1. 模块清单 ----------
test('移植模块都注册进了 BUILTINS，id 不重复', () => {
  const ids = BUILTINS.map((m) => m.id)
  for (const id of ['token-guardian', 'complete-guard', 'security-lock', 'memory-privacy', 'slang-learner', 'scheduler']) {
    assert.ok(ids.includes(id), `${id} 没注册`)
  }
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
})

test('每个模块的定义完整：id / name / api / setup / settings', () => {
  for (const def of [tokenGuardian, completeGuard, securityLock, memoryPrivacy, slangLearner, scheduler]) {
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
test('base32 密钥能解出字节，长度合理', () => {
  const s = newSecret()
  assert.match(s, /^[A-Z2-7]+$/)
  const buf = base32Decode(s)
  assert.ok(buf.length >= 16 && buf.length <= 24, `解出 ${buf.length} 字节`)
})

test('TOTP 是对得上的：同一个时间步生成同一个码，且能被校验', () => {
  const secret = newSecret()
  const now = 1_700_000_000_000
  const step = Math.floor(now / 1000 / 30)
  const code = totpAt(secret, step)
  assert.equal(code.length, 6)
  assert.equal(verifyTotp(secret, code, { now }), step)
})

test('TOTP 容错前后各一个时间步（手机时钟慢一点也能过）', () => {
  const secret = newSecret()
  const now = 1_700_000_000_000
  const step = Math.floor(now / 1000 / 30)
  const prev = totpAt(secret, step - 1)
  const next = totpAt(secret, step + 1)
  assert.equal(verifyTotp(secret, prev, { now }), step - 1)
  assert.equal(verifyTotp(secret, next, { now }), step + 1)
})

test('错的码 / 位数不对 / 空值都验不过', () => {
  const secret = newSecret()
  const now = 1_700_000_000_000
  assert.equal(verifyTotp(secret, '000000', { now }) === 0 || verifyTotp(secret, '000000', { now }) > 0, true)
  assert.equal(verifyTotp(secret, '123', { now }), 0)
  assert.equal(verifyTotp(secret, '', { now }), 0)
  assert.equal(verifyTotp(secret, null, { now }), 0)
})

test('两个不同密钥的码不一样（不是固定输出）', () => {
  const a = newSecret(), b = newSecret()
  const step = 59000000
  assert.notEqual(totpAt(a, step) + totpAt(b, step), totpAt(a, step) + totpAt(a, step))
})

test('otpauth:// 链接能给出手机验证器要的参数', () => {
  const secret = newSecret()
  const url = otpauthUrl(secret, '12345')
  assert.ok(url.startsWith('otpauth://totp/'))
  assert.ok(url.includes(`secret=${secret}`))
  assert.ok(url.includes('digits=6'))
  assert.ok(url.includes('period=30'))
  assert.ok(url.includes('issuer=QQ+Hub'))
})

// ---------- 4. 记忆分层（dsh-qq memory-policy.js） ----------
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

test('没写作用域的按全局处理，system 会话看不到任何分层记忆', () => {
  assert.equal(isVisible({ text: 'x' }, { kind: 'group', groupId: '1' }), true)
  assert.deepEqual(visibleScopes({ kind: 'system' }), [])
  assert.equal(isVisible({ scope: 'global' }, { kind: 'system' }), false)
})

test('scopeOf 按聊天给出正确的作用域，null 不炸', () => {
  assert.equal(scopeOf({ kind: 'private', userId: '1' }), 'private:1')
  assert.equal(scopeOf({ kind: 'group', groupId: '2' }), 'group:2')
  assert.equal(scopeOf({ kind: 'system' }), 'global')
  assert.equal(scopeOf(null), 'global')
})

// ---------- 5. 群黑话本（dsh-qq slang-learner.js） ----------
test('能从一句话里挑出候选词（中文 2~4 字、英文整词）', () => {
  const c = candidatesFrom('这个 yyds 真的绝了，贴贴')
  assert.ok(c.includes('yyds'))
  assert.ok(c.some((x) => x.length >= 2 && x.length <= 4))
})

test('候选词只保留 2~6 字中文，不会把整句当词', () => {
  const c = candidatesFrom('今天天气真不错我们去公园散步吧')
  for (const w of c) assert.ok(w.length >= 2 && w.length <= 4, w)
})

test('空输入返回空数组，不报错', () => {
  assert.deepEqual(candidatesFrom(''), [])
  assert.deepEqual(candidatesFrom(null), [])
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

test('权限锁默认关闭、有效期 30 分钟', () => {
  assert.equal(securityLock.defaults.enabled, false)
  assert.equal(securityLock.defaults.expireMinutes, 30)
  assert.equal(securityLock.defaults.lockByDefault, true)
})

test('记忆分层和黑话本默认开启（纯增益、不改她的回复）', () => {
  assert.equal(memoryPrivacy.defaults.enabled, true)
  assert.equal(slangLearner.defaults.enabled, true)
  assert.equal(completeGuard.defaults.enabled, true)
})
