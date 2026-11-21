// 回归测试：群聊引用回复内联，防止引用说明脱节导致模型序号错乱、群里回复错人。
//
// 事故复现场景（2026-11-16）：
// 群友A说“那确实”，群友A又说“爆炒”[2]，主人发了“蒸你们变坏了”[3]（引用了更早之前某人的“豆包变了”）。
// 旧实现把每条消息中的引用剥离出来作为孤立段落追加在整个提示词的末尾：
//   [1] A：那确实
//   [2] A：爆炒
//   [3] 主人：蒸你们变坏了
//   （提示词指示说明...）
//   （引用 某人的消息：「豆包变了」）
// 导致模型以为末尾的引用是第 2 条选项，输出了 `<reply:2>哪变了`，系统查表命中 [2]（A的爆炒），
// 机器人引用了 A 的爆炒回了一句风马牛不相及的话，并在后续引发连环争执。
//
// 修复（2026-11-16，第一版）：
// 1. 引用说明直接内联在对应消息行内；
// 2. 移除末尾全局孤立的 quotes 文本段；
// 3. 提示词严明 `<reply:编号>` 必须对应上方方括号里的数字。
//
// 事故复发场景（2026-11-20）：内联把内容挤进同一行以后，模型读到了待回的内容、却按
// 「这一行是谁发的」取编号，于是把本来要回给 A 的话挂到 B 头上：
//   [20] o(900000007)：5.3flash不好用
//   [9]  Струны(900000008)：绝对是降智了啊 （引用 彼岸花 的消息：「现在感觉还行，120token/s」）
//   → 她 `<reply:9>`，正文「同一池子有人120有人0.8…」——这句其实是说给彼岸花的。
//
// 修复（第二版，本文件钉住）：
// 4. 前情引用**单独成缩进行**并以 `↳ 转述 X 的话：「…」` 开头，与「本条发言人在说」分家；
// 5. 提示词里写明 `↳ 转述` 后面才是那句话的主人；
// 6. `<reply:…>` 接受编号 / 昵称 / QQ 号三种写法（解析层见 test/pure.test.js，
//    查表见 test/reply-delivery.test.js）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function capturingDsh({ assistantReply = '收到' } = {}) {
  const listeners = new Set()
  const session = { id: 'sess-quote-inline' }
  const contextsMap = new Map()
  const prompts = []
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: (name) => (name === 'contexts' ? { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k), values: () => contextsMap.values() } : null) },
    followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: assistantReply }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
      return Promise.resolve()
    },
  }
  const ctrl = { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-quote', path: 'ws-quote' }], create: async () => ({ id: 'ws-quote', path: 'ws-quote' }) }
      return null
    },
  }
  return { ctx, prompts }
}

function makeCore(dsh, { onebotCalls = [], messages = {} } = {}) {
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['888'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1, groupWaitSec: 0.02, groupMaxSec: 0.1 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3 },
  }
  const onebot = {
    call: async (action, params) => {
      onebotCalls.push({ action, params })
      if (action === 'get_msg') {
        const id = String(params.message_id || '')
        if (messages[id]) return messages[id]
        return { sender: { user_id: '99999', nickname: '路人' }, message: [{ type: 'text', data: { text: '某条原话' } }] }
      }
      return { message_id: 100000 + onebotCalls.length }
    },
  }
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot,
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return core
}

let midSeq = 5000
const groupMsg = ({ userId, nickname, text, replyId, at = false, mid = ++midSeq }) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 888,
  self_id: 20000002, user_id: userId, message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, nickname },
  message: [
    ...(replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : []),
    ...(at ? [{ type: 'at', data: { qq: 20000002 } }] : []), /* pii-scan:ignore */
    ...(text ? [{ type: 'text', data: { text: at ? ` ${text}` : text } }] : []),
  ],
})

test('群聊提示词：引用说明必须内联在发言人行内，末尾不得出现孤立引用段落', async () => {
  const dsh = capturingDsh()
  const messages = {
    '101': { sender: { user_id: 900000011, nickname: 'kiss伏太' }, message: [{ type: 'text', data: { text: '豆包变了' } }] },
    '102': { sender: { user_id: 900000010, nickname: '洛书' }, message: [{ type: 'text', data: { text: '接炮机更爽了' } }] },
  }
  const core = makeCore(dsh, { messages })
  try {
    // 模拟现场：
    // [1] 用户A: 那确实
    // [2] 用户A: 爆炒
    // [3] 主人: 蒸你们变坏了（引用 101: kiss伏太「豆包变了」）
    // [4] 洛书@bot: 接话触发
    await core.dispatchLegacyEvent(groupMsg({ userId: 900000006, nickname: 'A君', text: '那确实' }))
    await core.dispatchLegacyEvent(groupMsg({ userId: 900000006, nickname: 'A君', text: '爆炒' }))
    await core.dispatchLegacyEvent(groupMsg({ userId: 10000001, nickname: '主人', text: '蒸你们变坏了', replyId: '101' }))
    await core.dispatchLegacyEvent(groupMsg({ userId: 900000010, nickname: '洛书', text: '接炮机', replyId: '102', at: true }))
    await sleep(250)

    assert.equal(dsh.prompts.length, 1)
    const prompt = dsh.prompts[0]

    // 1. 验证引用挂在**发言人这一块**的下方，用 ↳ 转述 与「本条在说」区分开
    assert.match(prompt, /\[3\] 主人：[^\n]*\n    ↳ 转述 kiss伏太\(900000011\) 的话：「豆包变了」/, '主人的前情引用必须挂在主人这一行下方，且用 ↳ 转述 标注')
    assert.match(prompt, /\[4\] 洛书\(900000010\)[^\n]*：[^\n]*\n    ↳ 转述 洛书\(900000010\) 的话：「接炮机更爽了」/, '洛书的前情引用必须挂在自己这一行下方')
    // 引用正文绝不能挤进发言行本体，否则模型会把「谁说的」和「被转述的人」搞混
    assert.doesNotMatch(prompt, /蒸你们变坏了[^\n]*「豆包变了」/, '引用正文不得混进发言行本体')

    // 2. 验证末尾不再出现换行后脱离发言人的独立孤立引用段
    // 提示词结尾在「QQ 号就是上面名字后面括号里的数字。」之后不应再有一整行单独的「（引用 ... 的消息」
    const afterInstructions = prompt.split('QQ 号就是上面名字后面括号里的数字。')[1] || ''
    assert.doesNotMatch(afterInstructions, /（引用 [^\n]* 的消息/, '提示词说明之后绝不能再有孤立脱离的引用段落')

    // 3. 验证指示文案明确了编号/昵称/QQ号三种写法，以及 ↳ 转述 的主人是谁
    assert.match(prompt, /编号必须且只能是上面方括号里的数字/, '提示词明确要求编号只能对应方括号标号')
    assert.match(prompt, /<reply:昵称>/, '提示词给出按昵称引用的写法')
    assert.match(prompt, /<reply:QQ号>/, '提示词给出按 QQ 号引用的写法')
    assert.match(prompt, /以「↳ 转述」开头的[^\n]*真正的主人/, '提示词说明 ↳ 转述 后面才是那句话的主人')
  } finally {
    await core.dispose()
  }
})

test('群聊提示词：纯引用无正文消息正确格式化，不丢失引用说明', async () => {
  const dsh = capturingDsh()
  const messages = {
    '201': { sender: { user_id: 111, nickname: '路人乙' }, message: [{ type: 'text', data: { text: '某段历史消息' } }] },
  }
  const core = makeCore(dsh, { messages })
  try {
    // 纯引用回复，无任何文本内容
    await core.dispatchLegacyEvent(groupMsg({ userId: 222, nickname: '静默者', text: '', replyId: '201' }))
    await core.dispatchLegacyEvent(groupMsg({ userId: 333, nickname: '触发者', text: '看上面', at: true }))
    await sleep(250)

    assert.equal(dsh.prompts.length, 1)
    const prompt = dsh.prompts[0]
    assert.match(prompt, /\[1\] 静默者\(222\)：[^\n]*\n    ↳ 转述 路人乙\(111\) 的话：「某段历史消息」/, '纯引用无正文时，正文位置给出占位，引用说明挂在下方')
  } finally {
    await core.dispose()
  }
})
