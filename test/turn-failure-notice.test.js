// 回合失败回执回归（2026-11-27）：
//
// 背景：真机 11-27 14:29 / 14:30 两条「你不能帮我查保修吗」被上游网关
// （codearts_upstream / InferHub.ModelArts）以 403 判成「非编程话题」拒绝，
// **QQ 侧全程静默** —— 用户只看到她没反应，要翻后台日志才知道这轮没跑成。
//
// 过去只有 413（请求体过大）、超时、blocked 三条失败路径有回执，
// 其余（内容审核 / 限流 / 模型抖动）一律只写日志。本文件锁住补上的那部分：
//   ① 失败分类：403 内容审核 / 429 限流 / 超窗 / 其他，各自给用户不同的话；
//   ② 群聊不发回执（当众解释技术故障观感差），只发私聊；
//   ③ 同聊天 5 分钟内最多提示一次，避免模型持续挂掉时刷屏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

/** 最小核心：只为了拿 classifyTurnFailure / handleTurnFailure 两个测试出口。 */
function makeCore(t) {
  process.env.DSH_QQ_HUB_DATA_DIR = mkdtempSync(join(tmpdir(), 'turn-fail-'))
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] },
    merge: { waitSec: 0.01, maxSec: 0.04, groupWaitSec: 0.01, groupMaxSec: 0.04 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3, cadence: { enabled: false } },
    memory: { enabled: true, recallCount: 4 },
  }
  const sent = []
  const dsh = {
    on: () => () => {},
    get: () => null,
  }
  const core = createModularCore({
    dsh,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    // outbox 用真实实现时会尝试走 onebot；这里只需要观察「有没有请求投递」，
    // 所以用 sharedOutbox 的替身：request 被调用就记下来。
    sharedOutbox: {
      request: (d) => { sent.push(d); return Promise.resolve({ ok: true }) },
      dispose: () => {},
      notePrivateSource: () => {},
    },
  })
  t.after(() => { try { core.dispose() } catch {} })
  return { core, sent }
}

// ---------- ① 分类 ----------

test('分类：上游内容策略 403 → moderation，文案说明「不是我不理你」', (t) => {
  const { core } = makeCore(t)
  const raw = '403: {"code":"codearts_upstream","message":"上游返回（InferHub.ModelArts.81011.403）：抱歉，我无法提供关于您提问内容的建议。作为 AI 编程助手，我更擅长协助您处理代码编写…","type":"invalid_request_error"}'
  const r = core.classifyTurnFailure(new Error(raw))
  assert.equal(r.kind, 'moderation')
  assert.match(r.text, /审核|拦/)
  assert.match(r.text, /不是我不理你/)
})

test('分类：content_filter / 敏感内容 / 1026 也算内容审核', (t) => {
  const { core } = makeCore(t)
  for (const raw of [
    'finish_reason: content_filter',
    '内容审核未通过',
    '{"code":"1026"}',
    'input new sensitive',
  ]) {
    assert.equal(core.classifyTurnFailure(new Error(raw)).kind, 'moderation', raw)
  }
})

test('分类：429 / 限流 / 冷却 → rate-limit，提示等一会儿', (t) => {
  const { core } = makeCore(t)
  for (const raw of [
    '429: {"code":"routing_cooldown","message":"当前路由对象处于冷却期"}',
    'rate limit exceeded',
    '模型额度用完了',
    '所有启用中的账号都被限制器拦下',
  ]) {
    const r = core.classifyTurnFailure(new Error(raw))
    assert.equal(r.kind, 'rate-limit', raw)
    assert.match(r.text, /限流|等一会儿/)
  }
  // HTTP status 也认
  assert.equal(core.classifyTurnFailure({ failure: { status: 429, message: 'x' } }).kind, 'rate-limit')
})

test('分类：上下文窗口不够 → context-window，提示会重新开始', (t) => {
  const { core } = makeCore(t)
  const r = core.classifyTurnFailure(new Error('CONTEXT_WINDOW_EXCEEDED: maximum context length is 200000 tokens'))
  assert.equal(r.kind, 'context-window')
  assert.match(r.text, /重新开始/)
})

test('分类：其余错误 → error，给「再跟我说一次」而不是沉默', (t) => {
  const { core } = makeCore(t)
  for (const raw of ['fetch failed', 'ECONNRESET', 'turn/end kind=error', '']) {
    const r = core.classifyTurnFailure(new Error(raw))
    assert.equal(r.kind, 'error', JSON.stringify(raw))
    assert.ok(r.text.length > 0)
  }
})

test('分类：不抛（undefined / null / 怪形状都要能分类）', (t) => {
  const { core } = makeCore(t)
  for (const bad of [undefined, null, {}, { failure: null }, 0, '']) {
    assert.doesNotThrow(() => core.classifyTurnFailure(bad))
    assert.equal(typeof core.classifyTurnFailure(bad).kind, 'string')
  }
})

// ---------- ② 群聊不发、私聊才发 ----------

test('回执：群聊不发（当众解释技术故障观感差），只发私聊', (t) => {
  const { core, sent } = makeCore(t)
  const g = core.handleTurnFailure('group:777', new Error('fetch failed'))
  assert.equal(g.sent, false, '群聊不应发回执')
  assert.equal(sent.length, 0)

  const p = core.handleTurnFailure('private:10000001', new Error('fetch failed'))
  assert.equal(p.sent, true, '私聊应发回执')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatKey, 'private:10000001')
  assert.match(sent[0].segments[0].data.text, /再跟我说一次/)
})

// ---------- ③ 限频 ----------

test('回执：同聊天 5 分钟内只发一次（模型持续挂掉不刷屏）', (t) => {
  const { core, sent } = makeCore(t)
  const key = 'private:10000001'
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, true)
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, false, '窗口内第二次应被限频')
  assert.equal(core.handleTurnFailure(key, new Error('429 rate limit')).sent, false, '换错误类型也仍限频')
  assert.equal(sent.length, 1, '实际只投递了第一条')
})

test('回执：不同聊天各自独立计数（A 的限频不影响 B）', (t) => {
  const { core, sent } = makeCore(t)
  assert.equal(core.handleTurnFailure('private:10000001', new Error('x')).sent, true)
  assert.equal(core.handleTurnFailure('private:10000002', new Error('x')).sent, true, '另一个聊天不受影响')
  assert.equal(sent.length, 2)
})

test('回执：notify=false 只记日志不发消息（测试/试探路径）', (t) => {
  const { core, sent } = makeCore(t)
  const r = core.handleTurnFailure('private:10000001', new Error('fetch failed'), { notify: false })
  assert.equal(r.sent, false)
  assert.equal(sent.length, 0)
  assert.equal(typeof r.kind, 'string', '仍然要给出分类便于日志')
})

test('回执：空 chatKey 不发也不抛', (t) => {
  const { core, sent } = makeCore(t)
  for (const bad of ['', undefined, null]) {
    const r = core.handleTurnFailure(bad, new Error('x'))
    assert.equal(r.sent, false)
  }
  assert.equal(sent.length, 0)
})
// ---------- ④ 静态守卫：所有「回合失败出口」都必须有回执 ----------
//
// 这是为了防止本次踩过的坑重演：2026-11-27 首次实现时只补了 followupError 与
// execute 最外层 catch，**漏掉了「等待 replyPromise 时 turn/end 落 error」这个最常见出口**，
// 结果真机 16:10 的上游 403 依然完全静默，用户反馈「失败了还是静默」。
// 这条守卫把所有 `throw error` / `throw new Error(...回合...)` 的失败出口列出来，
// 要求每个出口附近（同一段 catch / 前 12 行内）出现 handleTurnFailure、handleTurnTimeout
// 或 handleOversizedTurn 三者之一 —— 三者都对应「已经通知用户」。
test('静态守卫：所有回合失败出口都必须有回执（超时 / 413 / 分类回执任一）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')
  const lines = src.split('\n')

  // 只找「回合执行」范围内的失败抛出点（turn.chatKey 存在 = 这一轮属于某个聊天）
  const throwIdx = []
  lines.forEach((line, i) => {
    if (/^\s*throw\s+(error|new Error\(`(DSH )?回合|new Error\(`主动回合)/.test(line)) throwIdx.push(i)
  })
  assert.ok(throwIdx.length >= 3, `至少应有 3 个失败出口，实际找到 ${throwIdx.length} 个（守卫本身要能工作）`)

  const NOTIFIERS = /handleTurnFailure|handleTurnTimeout|handleOversizedTurn/
  const missing = []
  for (const i of throwIdx) {
    // 往前看 12 行（覆盖整个 catch 块直到 throw），必须出现任一通知器
    const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
    if (!NOTIFIERS.test(window)) missing.push(`${i + 1}: ${lines[i].trim()}`)
  }
  assert.deepEqual(missing, [], `这些失败出口没有通知用户（会静默）：\n${missing.join('\n')}`)
})
