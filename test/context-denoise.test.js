// 上下文去噪回归测试（refactor/context-denoise）：
//   1. contextFor 最近经历超过 30 分钟用稳定钟点（HH:mm），不随小时跳字触发 DSH runtime-context 重复快照；
//   2. recallHint 按 sessionId 冷却去重（同会话连续轮次不反复刷同一条高权记忆），新会话重置；
//   3. 群聊每轮消息去掉 686 字固定协议尾巴（收进 L0 协议层），仅在含图/含转述时按需附 1 行；
//   4. voice.enabled=false 时 L0 协议层不再教模型写 <voice>。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/features/memory.js'
import { rulesText } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'
import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeMemStore() {
  const dir = mkdtempSync(join(tmpdir(), 'context-denoise-mem-'))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: '10000001', memory: { enabled: true } })
  const store = createMemoryStore({ dsh: {}, getConfig: () => cfg, log: noopLog })
  const cleanup = () => {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
  return { store, cleanup }
}

test('记忆去噪：同 sessionId 连续轮次不重复注入同一条记忆，换新 sessionId 后重新可见', () => {
  const { store, cleanup } = makeMemStore()
  try {
    const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
    store.add({ text: '主人非常反感聊天时频繁发白眼表情', about: '10000001', importance: 0.95, scope: 'private:10000001' })

    const h1 = store.recallHint(chat, '白眼表情', '', { sessionId: 'sess-1' })
    assert.match(h1, /你记得这些事：\n/, '使用精简记忆头，不再每轮复读 40 字套话')
    assert.match(h1, /频繁发白眼表情/)

    // 同一会话紧接着再来几轮：冷却窗内不再重复塞同一条
    const h2 = store.recallHint(chat, '白眼表情', '', { sessionId: 'sess-1' })
    assert.equal(h2, '', '同会话连续轮次不重复注入刚喂过的记忆')

    // 同一会话后续无关闲聊：不再触发泛问兜底强塞无关旧事
    const h3 = store.recallHint(chat, '今天吃什么', '', { sessionId: 'sess-1' })
    assert.equal(h3, '', '同会话后续轮次无命中时不强塞兜底记忆')

    // 换新会话（压缩/重置后）：记忆立即可用，绝不失忆
    const hNew = store.recallHint(chat, '白眼表情', '', { sessionId: 'sess-2' })
    assert.match(hNew, /频繁发白眼表情/, '新会话应重新可召回')
  } finally {
    cleanup()
  }
})

test('记忆去噪：冷却窗口过完后（8 轮后），同会话再次聊到仍可重新召回', () => {
  const { store, cleanup } = makeMemStore()
  try {
    const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
    store.add({ text: '主人的猫叫年糕', about: '10000001', importance: 0.9, scope: 'private:10000001' })

    assert.match(store.recallHint(chat, '年糕', '', { sessionId: 'sess-cool' }), /年糕/)
    for (let i = 0; i < 7; i += 1) {
      assert.equal(store.recallHint(chat, '年糕', '', { sessionId: 'sess-cool' }), '', `第 ${i + 2} 轮仍在冷却窗内`)
    }
    // 第 9 轮（距上次注入已满 8 轮）重新可召回
    assert.match(store.recallHint(chat, '年糕', '', { sessionId: 'sess-cool' }), /年糕/)
  } finally {
    cleanup()
  }
})

test('L0 协议层：收拢记忆规则与群聊引用规则；voice.enabled=false 时不教 <voice>', () => {
  const privOff = rulesText('private', normalize({ ownerQQ: '10000001', voice: { enabled: false } }))
  assert.doesNotMatch(privOff, /<voice>/, '语音关着不教 <voice>')
  assert.match(privOff, /你记得这些事/, 'L0 协议层一次性说明记忆块用法')
  assert.doesNotMatch(privOff, /<reply:编号>/, '私聊不塞群聊引用规则')

  const privOn = rulesText('private', normalize({ ownerQQ: '10000001', voice: { enabled: true } }))
  assert.match(privOn, /<voice>/, '语音开着正常教 <voice>')

  const groupRules = rulesText('social', normalize({ ownerQQ: '10000001' }))
  assert.match(groupRules, /<reply:编号>/, '群聊完整引用规则收在 L0 协议层')
  assert.match(groupRules, /↳ 转述/, '群聊转述规则收在 L0 协议层')
})

test('群聊去噪：纯文字群消息尾巴不再重复贴 686 字协议说明书，含转述才按需提醒', async () => {
  const prompts = []
  const listeners = new Set()
  const session = { id: 'sess-denoise-group' }
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: () => null },
    followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '收到' }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
      return Promise.resolve()
    },
  }
  const ctrl = { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
  const dsh = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-1', path: 'ws-1' }], create: async () => ({ id: 'ws-1', path: 'ws-1' }) }
      return null
    },
  }
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.01, maxSec: 0.04, groupWaitSec: 0.01, groupMaxSec: 0.04 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3, cadence: { enabled: false } },
  }
  const core = createModularCore({
    dsh,
    onebot: {
      call: async (action) => {
        if (action === 'get_msg') return { sender: { user_id: 666, nickname: '路人甲' }, message: [{ type: 'text', data: { text: '原话内容' } }] }
        return { message_id: 1 }
      },
    },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  try {
    // 第 1 轮：纯文字 @ 消息
    await core.dispatchLegacyEventSettled({
      post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
      self_id: 20000002, user_id: 555, message_id: 1001, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 555, nickname: '阿强' },
      message: [{ type: 'at', data: { qq: '20000002' } }, { type: 'text', data: { text: '晚饭吃啥' } }],
    })
    assert.equal(prompts.length, 1)
    assert.doesNotMatch(prompts[0], /写法三选一/, '纯文字群消息不再每轮重复贴 686 字 <reply:> 说明书')
    assert.doesNotMatch(prompts[0], /不得猜图中的人物/, '纯文字群消息不附图片占位提示')
    assert.doesNotMatch(prompts[0], /↳ 转述/, '无引用转述时不附转述提示')

    // 第 2 轮：带引用（↳ 转述）的消息
    await core.dispatchLegacyEventSettled({
      post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
      self_id: 20000002, user_id: 555, message_id: 1002, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 555, nickname: '阿强' },
      message: [{ type: 'reply', data: { id: '900' } }, { type: 'at', data: { qq: '20000002' } }, { type: 'text', data: { text: '你咋看' } }],
    })
    await sleep(30)
    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /↳ 转述/, '含引用消息时正常附转述提醒')
    assert.doesNotMatch(prompts[1], /写法三选一/, '依然不贴整段 686 字协议说明书')
  } finally {
    await core.dispose()
  }
})
