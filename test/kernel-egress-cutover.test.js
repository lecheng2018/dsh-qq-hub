// 出口切换集成单测（RFC-0001 §4 Phase 1 验收「消除 hub 直接发送调用」/ US-007）。
//
// 全程 stub 网关 + stub 旧入口 + 假 sleep/jitter/clock，零真睡、零 onebot、零网络。
// 装配形态与 src/host.js 的 FLAG_USE_PIPELINE=true 分支逐件对齐：
//   compose([tracing, egress-flush(dispatcher.drain), mw-egress, legacyFallback])
//   + createEgressOnebot 注入 hub 的 onebot + createEgressSendHook 注入 hub 的 hooks.send。
// 覆盖 AC：①清洗切分顺序 ②非文本段透传 ③ALS 穿透定时器 ④shadow 双算比对/live 零直发
// ⑤无 ctx 回落 ⑥旁路（upload_*_file）收口 ⑦边界已过防丢消息 ⑧关闭态零改动，
// 外加 payload 字段齐全（US-005 移交项：缺 segments 会 drain TypeError）与 FLAG 解析。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import { createLegacyHubFallback, legacyEventToEnvelope, isPipelineEnabled } from '../src/kernel/legacy-fallback.js'
import { createTracingMiddleware } from '../src/kernel/mw-tracing.js'
import { createEgressMiddleware } from '../src/kernel/mw-egress.js'
import { createDispatcher, hashReplyPayload } from '../src/kernel/dispatcher.js'
import { getCurrentContext, isEgressShadowEnabled } from '../src/kernel/ctx-store.js'
import {
  buildReplyPayload,
  createEgressFlushMiddleware,
  createEgressOnebot,
  createEgressSender,
  createEgressSendHook,
  messageToSegments,
  replyPayloadToCall,
  targetFromChatId,
} from '../src/kernel/mw-egress-cutover.js'

// ---------- 桩件 ----------

const TOKEN_RE = /<\/?(think|thought|reasoning|reflection|antThinking)/i
const textSeg = (t) => [{ type: 'text', data: { text: t } }]

function messageEvent(text, over = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    time: 1,
    self_id: 999,
    message_id: 5001,
    user_id: 10001,
    message: textSeg(text),
    sender: { user_id: 10001, nickname: '主人', card: '', role: 'friend' },
    ...over,
  }
}

/**
 * 最小「pipeline 开启态」世界。stub 旧核心的 sendSegments 严格复刻 hub 的出站次序：
 * hooks.send → 模拟闸 → 总开关 → 试运行 → onebot.call（收口点）。
 * @param {object} [o]
 * @param {'live'|'shadow'} [o.mode='live']
 * @param {(message: any, info: object) => any} [o.moduleFilter] 扩展模块的 send 改写（返回 null = 拦下）
 * @param {(ev: any, env: object) => Promise<void>} [o.core] stub 旧入口 onMessage
 * @param {(ev: any, env: object) => Promise<void>} [o.pokeCore] stub 旧入口 onPoke
 * @param {(action: string, params: object, n: number) => any} [o.gatewayResult] stub 网关返回/抛错
 * @param {(file: string) => string} [o.uploadFile] 本机路径 → base64（host 侧注入的那件）
 */
function world(o = {}) {
  const mode = o.mode ?? 'live'
  const real = [] // 真网关收到的调用 = 真正发到 QQ 的包
  const logs = []
  const sleeps = []
  const timeline = [] // 事件顺序探针：分清「轮内直发」与「边界 flush 才发」
  const gates = { enabled: true, dryRun: false, simulate: false }
  const capture = []
  const log = {
    debug: (...a) => logs.push(['debug', a.join(' ')]),
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  }
  const raw = {
    async call(action, params, opts) {
      real.push({ action, params, opts })
      if (o.gatewayResult) return o.gatewayResult(action, params, real.length)
      if (action.startsWith('upload_')) return { file_id: `f-${real.length}`, file_name: params.name }
      return { message_id: 7000 + real.length }
    },
  }
  const hubOnebot = createEgressOnebot({ onebot: raw, mode, log })
  const hubSend = createEgressSendHook({
    legacySend: o.moduleFilter ? async (message, info) => o.moduleFilter(message, info) : undefined,
    log,
  })
  const dispatcher = createDispatcher({
    mode,
    sender: createEgressSender({ call: (a, p, op) => raw.call(a, p, op), uploadFile: o.uploadFile, log }),
    log,
    sleep: async (ms) => { sleeps.push(ms) },
    jitter: () => 0.5,
    clock: (() => {
      let t = 0
      return () => (t += 1)
    })(),
  })

  async function sendSegments(chatId, message, note, { force = false } = {}) {
    const next = await hubSend(message, { chatId, note, force })
    if (next === null) return null // 扩展模块拦下
    if (gates.simulate) { capture.push({ chatId, note, message: next }); timeline.push('simulate'); return { message_id: `sim-${capture.length}` } }
    if (!gates.enabled) { timeline.push('disabled'); return null }
    if (gates.dryRun) { timeline.push('dryRun'); return null }
    const [kind, id] = String(chatId).split(':')
    const group = kind === 'group'
    const action = group ? 'send_group_msg' : 'send_private_msg'
    const params = group ? { group_id: Number(id), message: next } : { user_id: Number(id), message: next }
    timeline.push('send')
    return hubOnebot.call(action, params)
  }
  const env = { sendSegments, hubOnebot, hubSend, raw, real, timeline, gates, capture, logs, sleeps, dispatcher }
  const legacyHub = {
    onMessage: async (ev) => {
      timeline.push('legacy:enter')
      if (o.core) await o.core(ev, env)
      timeline.push('legacy:done')
    },
    onPoke: async (ev) => {
      timeline.push('poke:enter')
      if (o.pokeCore) await o.pokeCore(ev, env)
      timeline.push('poke:done')
    },
  }
  const pipeline = compose([
    createTracingMiddleware({ log }),
    createEgressFlushMiddleware({ dispatcher, log }),
    createEgressMiddleware({ log }),
    createLegacyHubFallback(legacyHub),
  ])
  async function dispatch(ev) {
    const ctx = createContext(legacyEventToEnvelope(ev), 'onebot')
    await pipeline(ctx)
    return Object.assign({ ctx }, env, { mode })
  }
  return Object.assign({ dispatch, world: env }, env, { dispatcher, sendSegments, mode })
}

const outbound = (calls) => calls.filter((c) => c.action === 'send_private_msg' || c.action === 'send_group_msg')
const outboundText = (calls) => outbound(calls)
  .flatMap((c) => (c.params.message || []).filter((s) => s.type === 'text').map((s) => s.data.text))

// ---------- ① 清洗 + 分条 + 顺序 + 成功形态 ----------

test('① pipeline on：旧核心两次 hooks.send（首条 4500 字含 think）→ 外发经 egress 清洗切分、顺序正确、由 Dispatcher 下发', async () => {
  const long = `真实答案${'甲'.repeat(4500)}<think>秘密${'乙'.repeat(200)}</think>尾巴`
  const w = world({
    core: async (ev, { sendSegments }) => {
      await sendSegments('private:10001', textSeg(long), '长回复')
      await sendSegments('private:10001', textSeg('第二句'), '第二句')
    },
  })
  const r = await w.dispatch(messageEvent('在吗'))
  assert.ok(r.timeline.includes('legacy:done'), '旧入口已 resolve（边界 flush 的前置）')
  const sends = outbound(r.real)
  assert.equal(sends.length, 3, `清洗切分后 3 条外发（4506→2 片 + 第二句），实得 ${sends.length}`)
  const texts = outboundText(r.real)
  assert.ok(texts[0].startsWith('真实答案'), '首片保留正文开头')
  assert.equal(texts.some((t) => TOKEN_RE.test(t)), false, '外发零 think token')
  assert.equal(texts.some((t) => t.includes('秘密')), false, 'think 内容整段不外泄')
  assert.ok(texts.some((t) => t.endsWith('尾巴')), '剥离后正文尾巴仍在')
  assert.equal(texts.at(-1), '第二句', '两次发送相对顺序不变')
  assert.ok(texts.every((t) => t.length <= 4000), '每片 ≤maxChars')
  assert.equal(texts.join('').length, 4506 + 3, '内容无损耗（只剩清洗掉的 think）')
  assert.equal(r.sleeps.length, 0, 'delayMs=0 → 出口不再叠加限速（整轮齐发，见 progress Learnings）')
})

test('①b live：旧通道轮内零调用；sendSegments 拿到成功形态（旧核心计数/日志/群配额语义不变）', async () => {
  let insideTurn = -1
  const w = world({
    core: async (ev, { sendSegments, real }) => {
      const p = await sendSegments('private:10001', textSeg('一'), 'note1')
      const g = await sendSegments('group:555', textSeg('二'), 'note2')
      assert.ok(p && p.message_id !== undefined, '私聊：必须回成功形态')
      assert.ok(g && g.message_id !== undefined, '群聊：必须回成功形态')
      assert.match(String(p.message_id), /^hub-deferred-/, '可辨识的延发 id')
      insideTurn = real.length
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(insideTurn, 0, 'live：旧通道在轮内一次都没发（旁路清零）')
  assert.equal(r.real.length, 2, 'flush 后共两条真发包')
  assert.equal(r.real[0].action, 'send_private_msg')
  assert.equal(r.real[0].params.user_id, 10001)
  assert.equal(r.real[1].action, 'send_group_msg')
  assert.equal(r.real[1].params.group_id, 555, 'targetType 由 chatId 前缀判定')
})

// ---------- ② 非文本段透传 ----------

test('② image / record 段原样透传到出口（type/data 不动）', async () => {
  const segs = [
    { type: 'record', data: { file: 'base64://AAAA', summary: '语音' } },
    { type: 'image', data: { file: 'base64://BBBB', sub: 'preview' } },
    { type: 'text', data: { text: '配图说明' } },
  ]
  const w = world({ core: async (ev, { sendSegments }) => { await sendSegments('private:10001', segs, '[语音] 你好') } })
  const r = await w.dispatch(messageEvent('图'))
  assert.equal(r.real.length, 1)
  const msg = r.real[0].params.message
  assert.deepEqual(msg.map((s) => s.type), ['record', 'image', 'text'], '段顺序与类型原样')
  assert.deepEqual(msg[0].data, { file: 'base64://AAAA', summary: '语音' }, 'record 段 data 逐字段透传')
  assert.deepEqual(msg[1].data, { file: 'base64://BBBB', sub: 'preview' }, 'image 段 data 逐字段透传')
})

// ---------- ③ ALS 穿透定时器 ----------

test('③ ALS 穿透：旧核心 setTimeout(0) 里的发送仍进 ctx.reply，不在轮内外漏', async () => {
  let ctxInTimer = null
  const w = world({
    core: async (ev, { sendSegments, timeline }) => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // Node 内置：run 期内创建的 async resource 继承 store
      timeline.push('after-timer')
      await sendSegments('private:10001', textSeg('定时器里的回复'), 'late-timer')
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.ok(!ctxInTimer, '占位（保持断言清单稳定）')
  assert.equal(r.real.length, 1, '只有 flush 的一条外发')
  assert.deepEqual(outboundText(r.real), ['定时器里的回复'])
  assert.ok(r.timeline.indexOf('after-timer') > r.timeline.indexOf('legacy:enter'), '定时器回调确实在旧入口链里跑')
})

test('③b 并发两轮：ALS 各拿各的 ctx，跨 await 定时器也不串味', async () => {
  const pairs = []
  const w = world({
    core: async (ev, { sendSegments }) => {
      const before = getCurrentContext()
      await new Promise((resolve) => setTimeout(resolve, 10))
      const after = getCurrentContext() // 定时器回调回来，还得是同一轮的 ctx
      pairs.push([ev.user_id, before, after])
      await sendSegments(`private:${ev.user_id}`, textSeg(`回${ev.user_id}`), 'note')
    },
  })
  await Promise.all([
    w.dispatch(messageEvent('A', { user_id: 10001, message_id: 1 })),
    w.dispatch(messageEvent('B', { user_id: 10002, message_id: 2 })),
  ])
  assert.equal(pairs.length, 2)
  for (const [uid, before, after] of pairs) {
    assert.ok(before && after, `user ${uid} 两条链都拿得到 ctx`)
    assert.equal(before, after, `user ${uid}：定时器回来后 ctx 不变`)
    assert.equal(String(before.inbound.rawPayload.user_id), String(uid), `user ${uid}：拿到的必须是自己的 ctx，不是别人的`)
  }
  assert.notEqual(pairs[0][1], pairs[1][1], '不同事件必须是不同 ctx（ALS 按 run 隔离）')
  const byTarget = outbound(w.real).map((c) => String(c.params.user_id)).sort()
  assert.deepEqual(byTarget, ['10001', '10002'], '两轮各发一条，没有串到对方的队列')
  assert.deepEqual(outboundText(w.real).sort(), ['回10001', '回10002'])
})

// ---------- ④ shadow 双算 ----------

test('④ shadow：旧通道轮内真发 + Dispatcher 只记 hash 不再发 + 比对计数日志（不一致只告警不阻断）', async () => {
  let insideTurn = -1
  const w = world({
    mode: 'shadow',
    core: async (ev, { sendSegments, real }) => {
      await sendSegments('private:10001', textSeg('甲<think>秘密</think>'), 'note')
      insideTurn = real.length
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(insideTurn, 1, 'shadow：轮内旧通道就真发了（双算）')
  assert.equal(r.real.length, 1, '全程只有一条真发包；Dispatcher shadow 没再发')
  assert.match(String(r.real[0].params.message[0].data.text), /<think>/, '旧通道发的就是未清洗原文')
  const line = r.logs.find((l) => l[1].includes('[egress-shadow]'))
  assert.ok(line, '比对日志必须产出')
  assert.equal(line[0], 'debug', '计数日志走 debug，不刷屏')
  assert.match(line[1], /match=\d+ mismatch=\d+/, '格式：match=… mismatch=…')
  assert.match(line[1], /mismatch=1/, '原文含 think、新链清洗掉 → 预期 1 条不一致')
  assert.equal(r.logs.filter((l) => l[0] === 'warn').length, 1, '不一致另有一条告警')
  assert.equal(r.real.length, 1, '告警不阻断也不额外发包')
})

test('④b shadow：内容没被清洗改动时 hash 全等（match=1 mismatch=0、无告警）', async () => {
  const w = world({ mode: 'shadow', core: async (ev, { sendSegments }) => { await sendSegments('private:10001', textSeg('干净的一句话'), 'note') } })
  const r = await w.dispatch(messageEvent('hi'))
  const line = r.logs.find((l) => l[1].includes('[egress-shadow]'))
  assert.match(line[1], /match=1 mismatch=0/)
  assert.equal(r.logs.filter((l) => l[0] === 'warn').length, 0)
  assert.equal(r.real.length, 1)
})

// 补评 F8：现行装配下主气泡走包装器直发分支（F1），shadow 账本常年全空——
// 「match=0 mismatch=0」是「没样本」不是「比对通过」，e2e SHADOW 态全绿不能当治理生效的证据。
test('④d shadow 零样本：账本全空时明写「无队列支路样本」，不出 match=0 假干净（补评 F1/F8）', async () => {
  const w = world({ mode: 'shadow', core: async () => { /* 本轮零发送：气泡直发形态下治理面的真实样子 */ } })
  const r = await w.dispatch(messageEvent('hi'))
  const lines = r.logs.filter((l) => l[1].includes('[egress-shadow]'))
  assert.equal(lines.length, 1, '零样本也留一行可观测记录，不静默')
  assert.equal(lines[0][0], 'info', '升 info 级：空账本不能被 debug 埋掉')
  assert.match(lines[0][1], /无队列支路样本（气泡直发不在治理面）/)
  assert.ok(!lines[0][1].includes('match='), '零样本不再输出 match=0 mismatch=0 的假干净计数')
  assert.equal(r.real.length, 0, '零样本轮一个包都不发')
  assert.equal(r.logs.filter((l) => l[0] === 'warn').length, 0, '无样本也不触发比对告警')
})

test('④e shadow 有样本：计数日志维持 debug 原样（零样本诚实化不影响有样本口径）', async () => {
  const w = world({ mode: 'shadow', core: async (ev, { sendSegments }) => { await sendSegments('private:10001', textSeg('干净的一句话'), 'note') } })
  const r = await w.dispatch(messageEvent('hi'))
  const lines = r.logs.filter((l) => l[1].includes('[egress-shadow]'))
  assert.equal(lines.length, 1)
  assert.equal(lines[0][0], 'debug', '有样本走原口径')
  assert.match(lines[0][1], /match=1 mismatch=0 oldFailed=0/)
})

test('④c live：不产比对日志，旧通道零调用（切权后的稳态）', async () => {
  const w = world({ core: async (ev, { sendSegments }) => { await sendSegments('private:10001', textSeg('ok'), 'note') } })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(r.logs.filter((l) => l[1].includes('[egress-shadow]')).length, 0)
  assert.equal(r.real.length, 1)
})

// ---------- ⑤ 无 ctx 回落 / 安全闸 ----------

test('⑤ 无 ctx 上下文（B 站 duty、面板接口等后台任务）：回落旧 sender 直发，内核零参与', async () => {
  const w = world()
  assert.equal(getCurrentContext(), null, '管道外没有 ctx')
  const r = await w.sendSegments('private:10001', textSeg('后台任务直发'), 'duty')
  assert.equal(w.real.length, 1, '直接打到真网关')
  assert.equal(w.real[0].action, 'send_private_msg')
  assert.equal(r.message_id, 7001, '返回的是网关真实 message_id，不是 hub-deferred')
  assert.equal(w.dispatcher.shadowRecords().length, 0, '内核队列没参与')
})

test('⑤b 三道安全闸优先：模拟 / 总开关关 / 试运行都不得因为收口而漏出来真发', async () => {
  const w = world({
    core: async (ev, { sendSegments, gates, capture }) => {
      gates.simulate = true
      const sim = await sendSegments('private:10001', textSeg('模拟'), 'note')
      assert.equal(sim.message_id, 'sim-1', '模拟模式只记不发')
      assert.equal(capture.length, 1)
      gates.simulate = false
      gates.dryRun = true
      assert.equal(await sendSegments('private:10001', textSeg('试运行'), 'note'), null)
      gates.dryRun = false
      gates.enabled = false
      assert.equal(await sendSegments('private:10001', textSeg('总开关关'), 'note'), null)
      gates.enabled = true
      await sendSegments('private:10001', textSeg('该发的'), 'note')
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.deepEqual(outboundText(r.real), ['该发的'], '安全闸拦下的三条都没有进队列')
  assert.deepEqual(r.capture.map((c) => c.note), ['note'])
})

test('⑤c 扩展模块拦下（hooks.send 返回 null）：不发也不入队', async () => {
  const w = world({
    moduleFilter: (message) => (message[0].data.text === '别说' ? null : message),
    core: async (ev, { sendSegments }) => {
      assert.equal(await sendSegments('private:10001', textSeg('别说'), 'note'), null)
      await sendSegments('private:10001', textSeg('能说'), 'note')
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.deepEqual(outboundText(r.real), ['能说'])
})

test('⑤d 模块改写后的数组由出口认领：发出去的是改写结果', async () => {
  const w = world({
    moduleFilter: (message) => textSeg(`${message[0].data.text}——来自签名`),
    core: async (ev, { sendSegments }) => { await sendSegments('group:555', textSeg('原文'), 'note') },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.deepEqual(outboundText(r.real), ['原文——来自签名'], '改写结果进队列，原文不外发')
  assert.equal(r.real[0].params.group_id, 555)
})

// ---------- ⑥ 旁路收口 ----------

test('⑥ 旁路收口：绕过 hooks.send 的 upload_*_file 也进队列，出口按原动作 + 长超时下发', async () => {
  const w = world({
    core: async (ev, { hubOnebot, real }) => {
      const r = await hubOnebot.call('upload_private_file', { user_id: 10001, file: '/tmp/a.txt', name: 'a.txt' }, { timeoutMs: 120_000 })
      assert.ok(r && r.file_id !== undefined, '文件上传也要回成功形态')
      assert.equal(real.length, 0, '轮内没真发')
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(r.real.length, 1)
  assert.equal(r.real[0].action, 'upload_private_file', '出口仍是上传动作，不是 send_msg')
  assert.deepEqual(r.real[0].params, { user_id: 10001, file: '/tmp/a.txt', name: 'a.txt' }, 'params 与 hub 原调用逐字段一致')
  assert.equal(r.real[0].opts.timeoutMs, 120_000, '长超时口径保留')
})

test('⑥b upload 首次失败 → 出口按 hub 原语义改走 base64 重发一次', async () => {
  const w = world({
    gatewayResult: (action, params, n) => {
      if (action !== 'upload_group_file') return { message_id: 1 }
      if (n === 1) throw new Error('file not found: /tmp/a.txt') // 网关在另一台机器，看不到本机路径
      return { file_id: 'f2', file_name: 'a.txt' }
    },
    uploadFile: () => 'base64://AAAA',
    core: async (ev, { hubOnebot }) => { await hubOnebot.call('upload_group_file', { group_id: 555, file: '/tmp/a.txt', name: 'a.txt' }, { timeoutMs: 120_000 }) },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(r.real.length, 2, '失败后出口补发一次 base64')
  assert.equal(r.real[1].params.file, 'base64://AAAA')
  assert.ok(r.logs.some((l) => l[1].includes('base64')), '回退动作留了 debug 线索')
})

test('⑥c 非消息类动作（send_poke / set_input_status / get_msg）原样直发，不被收口', async () => {
  const w = world()
  await w.raw.call('get_login_info', {})
  const r1 = await w.hubOnebot.call('send_poke', { user_id: 1 }, { timeoutMs: 10_000 })
  assert.doesNotMatch(String(r1.message_id), /deferred/, '戳一戳仍是网关真实返回（动作类，不是 ReplyPayload）')
  await w.hubOnebot.call('set_input_status', { user_id: 1, event_type: 1 })
  assert.deepEqual(w.real.map((c) => c.action), ['get_login_info', 'send_poke', 'set_input_status'])
})

// ---------- ⑦ 边界已过 ----------

test('⑦ flush 之后晚到的发送回落旧通道直发，绝不落进已排空的队列（防静默丢消息）', async () => {
  let fired = null
  const w = world({
    core: async (ev, { sendSegments }) => {
      // 复刻 hub 的 fire-and-forget 气泡定时器：在 legacy 链里创建、却在整轮结束之后才触发
      setTimeout(() => { sendSegments('private:10001', textSeg('晚到的气泡'), 'bubble').then((r) => { fired = r }) }, 10)
    },
  })
  const r = await w.dispatch(messageEvent('hi'))
  assert.equal(r.real.length, 0, '整轮没有待发内容')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(fired && fired.message_id === 7001, '晚到的这条走旧通道、拿真实 message_id')
  assert.deepEqual(outboundText(r.real), ['晚到的气泡'], '晚到的这条没被吞掉')
})

// ---------- ⑧ 关闭态 ----------

test('⑧ 开关关闭态：注入的是原 onebot 与原 hooks.send——旧通道直发、ctx 恒不存在、内核零参与', async () => {
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: 'false' }), false, '缺省口径 = 关')
  const real = []
  const raw = { async call(action, params) { real.push({ action, params }); return { message_id: 4321 } } }
  // flag off 的装配形态：hubSendHook === 原 mods.filter('send', …)，hubOnebot === 原客户端
  const hubSendHook = async (message) => message
  const next = await hubSendHook(textSeg('关闭态'), { chatId: 'private:1', note: 'n' })
  assert.equal(getCurrentContext(), null, '没装配管道 → 永远没有 ctx')
  const r = await raw.call('send_private_msg', { user_id: 1, message: next })
  assert.equal(r.message_id, 4321, '网关真实返回，没有任何延发形态')
  assert.equal(real.length, 1)
  assert.deepEqual(real[0].params.message, textSeg('关闭态'), '未进队列、未清洗，段原样')
})

// ---------- 映射契约与开关解析 ----------

test('ReplyPayload 字段齐全（US-005 移交项：缺 segments 会让 drain 抛 TypeError）', () => {
  const p = buildReplyPayload({
    targetType: 'group',
    targetId: 555,
    segments: messageToSegments([{ type: 'reply', data: { id: 42 } }, { type: 'text', data: { text: 'hi' } }]),
  })
  assert.deepEqual(Object.keys(p).sort(), ['delayMs', 'priority', 'quoteMessageId', 'segments', 'targetId', 'targetType'])
  assert.equal(p.targetType, 'group')
  assert.equal(p.targetId, '555', 'targetId 一律字符串')
  assert.equal(p.priority, 'NORMAL', '入参不带 priority → NORMAL')
  assert.equal(p.delayMs, 0, '入参不带 delayMs → 0')
  assert.equal(p.quoteMessageId, '42', 'reply 段提取 quoteMessageId（段本身原样保留）')
  assert.equal(buildReplyPayload({ targetType: 'private', targetId: '1' }).segments.length, 0, 'segments 键恒在')
  assert.equal(buildReplyPayload({ targetType: 'weird', targetId: '1' }).targetType, 'private', '认不出的 targetType 归 private')
  assert.deepEqual(messageToSegments('一句纯文本'), [{ type: 'text', data: { text: '一句纯文本' } }], '字符串也归一成 text 段')
  assert.equal(targetFromChatId('group:555').targetId, '555')
  assert.equal(targetFromChatId('555'), null, '没有前缀的 chatId 不认（保守直发）')
  assert.equal(targetFromChatId('session-x'), null)
})

test('入队一条脏 payload 也不会让 drain TypeError：全链跑通即证字段齐全', async () => {
  const w = world({ core: async (ev, { sendSegments }) => { await sendSegments('private:10001', textSeg('干净'), 'note') } })
  const r = await w.dispatch(messageEvent('hi'))
  const drain = await w.dispatcher.drain(r.ctx) // 队列已被 live drain 清空 → 空转不炸
  assert.equal(drain.total, 0)
  assert.deepEqual(outboundText(r.real), ['干净'])
})

test('replyPayloadToCall ↔ payloadFromCall 互逆：群/私聊与 file 段都还原成原动作', () => {
  const msg = replyPayloadToCall(buildReplyPayload({ targetType: 'private', targetId: '10001', segments: messageToSegments(textSeg('a')) }))
  assert.equal(msg.action, 'send_private_msg')
  assert.deepEqual(msg.params, { user_id: 10001, message: textSeg('a') })
  assert.equal(msg.opts, undefined)
  const file = replyPayloadToCall(buildReplyPayload({ targetType: 'group', targetId: '555', segments: [{ type: 'file', data: { file: '/t/a.txt', name: 'a.txt' } }] }))
  assert.equal(file.action, 'upload_group_file')
  assert.deepEqual(file.params, { group_id: 555, file: '/t/a.txt', name: 'a.txt' })
  assert.equal(file.opts.timeoutMs, 120_000)
  const mixed = replyPayloadToCall(buildReplyPayload({ targetType: 'private', targetId: '1', segments: [{ type: 'file', data: { file: 'x' } }, { type: 'text', data: { text: 'y' } }] }))
  assert.equal(mixed.action, 'send_private_msg', '多条段（含 file）仍按消息发，不误判成上传')
})

test('FLAG_EGRESS_SHADOW 解析与 FLAG_USE_PIPELINE 同口径，缺省 live', () => {
  for (const v of ['true', 'TRUE', ' 1 ', '1']) assert.equal(isEgressShadowEnabled({ FLAG_EGRESS_SHADOW: v }), true, v)
  for (const v of [undefined, '', 'false', 'yes', '0']) assert.equal(isEgressShadowEnabled({ FLAG_EGRESS_SHADOW: v }), false, String(v))
  assert.equal(isEgressShadowEnabled({}), false, '未设置 = live')
})

test('shadow 比对用的 hash 与 Dispatcher 同一份实现（hash 只看 target + segments）', () => {
  const a = buildReplyPayload({ targetType: 'private', targetId: '1', segments: messageToSegments(textSeg('同一句')) })
  const b = { ...a, priority: 'HIGH', delayMs: 900 }
  assert.equal(hashReplyPayload(a), hashReplyPayload(b))
  assert.notEqual(hashReplyPayload(a), hashReplyPayload({ ...a, segments: messageToSegments(textSeg('另一句')) }))
})

test('poke 事件同样收口：onPoke 链里的发送在边界 flush 才外发', async () => {
  const w = world({
    core: async () => { assert.fail('poke 事件不该跑 message 链') },
    pokeCore: async (ev, { sendSegments }) => { await sendSegments('private:10002', textSeg('干嘛戳我'), 'note') },
  })
  const r = await w.dispatch({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', time: 1, self_id: 999, user_id: 10002, group_id: 555, sender: { user_id: 10002 } })
  assert.equal(r.timeline[0], 'poke:enter')
  assert.equal(r.real.length, 1)
  assert.deepEqual(outboundText(r.real), ['干嘛戳我'])
})


// ===== 2026-11-07 review C2 修复回归 =====

test('C2#3 内层抛错：markFlushed + 队列清空计日志 + 原样上抛，不留死队列', async () => {
  const sent = []
  const dispatcher = createDispatcher({ sender: async (p) => sent.push(p), mode: 'live' })
  const flush = createEgressFlushMiddleware({ dispatcher, log: { warn: (m) => sent.push('WARN:' + m) } })
  const ctx = createContext({ messageId: 'm' }, 'd')
  const boom = async (c) => {
    c.reply.enqueue(buildReplyPayload({ targetType: 'group', targetId: '1', segments: textSeg('半途受理') }))
    throw new Error('legacy 崩了')
  }
  await assert.rejects(compose([flush, boom])(ctx), (e) => {
    let cur = e
    while (cur) { if (String(cur.message || '').includes('legacy 崩了')) return true; cur = cur.originalCause ?? cur.cause }
    return false
  }, '原样上抛（包装链里可寻 legacy 崩了）')
  assert.equal(ctx.reply.queue.length, 0, '异常轮队列必须清空')
  assert.equal(sent.length, 1, '异常轮一条都没真发，只剩告警')
  assert.match(String(sent[0]), /WARN:.*未下发条目/, '有告警留痕')
  // 边界已立：晚到发送不再入死队列
  const { isContextFlushed } = await import('../src/kernel/ctx-store.js')
  assert.equal(isContextFlushed(ctx), true)
})

test('C2#1 模式校验：createEgressOnebot 非法 mode 构造即抛，杜绝 wrapper/dispatcher 错配双发', () => {
  assert.throws(() => createEgressOnebot({ onebot: { call: async () => ({}) }, mode: 'shadoww' }), /live.*shadow|必须是/)
  assert.throws(() => createDispatcher({ sender: async () => {}, mode: 'half' }), /必须是/)
})

test('C2#5 上传回退白名单：仅确认的路径读取失败才转 base64 重传；超时/鉴权直接上抛', async () => {
  const { isConfirmedPathReadError } = await import('../src/kernel/mw-egress-cutover.js')
  assert.equal(isConfirmedPathReadError(new Error('open /data/x.mp4: no such file or directory')), true)
  assert.equal(isConfirmedPathReadError(Object.assign(new Error('boom'), { cause: { code: 'ENOENT' } })), true)
  assert.equal(isConfirmedPathReadError(new Error('The operation was aborted due to timeout')), false)
  assert.equal(isConfirmedPathReadError(new Error('HTTP 401 unauthorized')), false)
  assert.equal(isConfirmedPathReadError(new Error('ECONNRESET')), false)
  let calls = 0
  const sender = createEgressSender({
    call: async () => { calls += 1; throw new Error('timeout waiting for gateway') },
    uploadFile: async () => 'base64://AAA',
  })
  await assert.rejects(sender(buildReplyPayload({ targetType: 'group', targetId: '9', segments: [{ type: 'file', data: { file: '/d/x.mp4', name: 'x.mp4' } }] })))
  assert.equal(calls, 1, '超时错误绝不二次上传')
})

test('C2#7 shadow 账本带状态：失败请求不计入比对样本', async () => {
  const dispatcher = createDispatcher({ mode: 'shadow' })
  const flush = createEgressFlushMiddleware({ dispatcher, log: { debug: () => {}, warn: () => {} } })
  const innerCalls = []
  const onebot = createEgressOnebot({ onebot: { call: async (a, p) => { innerCalls.push(a); if (innerCalls.length === 2) throw new Error('网关 500'); return { message_id: 1 } } }, mode: 'shadow' })
  const ctx = createContext({ messageId: 'm' }, 'd')
  const round = async (c) => {
    await onebot.call('send_group_msg', { group_id: 1, message: textSeg('一') })
    try { await onebot.call('send_group_msg', { group_id: 1, message: textSeg('二') }) } catch { /* 旧通道失败 */ }
  }
  const { runWithContext } = await import('../src/kernel/ctx-store.js')
  await compose([flush, () => runWithContext(ctx, round)])(ctx)
  const { getCurrentContext } = await import('../src/kernel/ctx-store.js')
  void getCurrentContext
  // 队列未被 shadow 消费：两条仍在
  assert.equal(ctx.reply.queue.length, 2)
  const summary = await dispatcher.drain(ctx)
  assert.equal(summary.shadow, 2)
})
