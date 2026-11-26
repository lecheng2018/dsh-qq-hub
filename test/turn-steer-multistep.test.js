// 回归（真机 2026-11-26 12:51）：私聊 steer 在同一 turn 内分出两个完整回复 step 时，
// 第一段回复不再被第二段覆盖吞掉；同时工具调用前置步与 runtime-context 不误拼。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(20)
  }
}

function scriptedDsh(onFollowup) {
  const listeners = new Set()
  const session = { id: 'sess-steer' }
  const emit = (ev) => { for (const fn of [...listeners]) fn(session, ev) }
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: () => null },
    steer: async () => {},
    followup(msg) {
      const n = ++turnNo
      return onFollowup({ turn: n, msg, emit })
    },
  }
  const ctrl = { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-steer', path: 'ws-steer' }], create: async () => ({ id: 'ws-steer', path: 'ws-steer' }) }
      return null
    },
  }
  return ctx
}

function makeHarness(onFollowup) {
  const sent = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: [] }, longTasks: false,
    merge: { waitSec: 0.01, maxSec: 0.05, groupWaitSec: 0.01, groupMaxSec: 0.05 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { privateMaxChars: 2000, maxBubbles: 6, cadence: { enabled: false } },
  }
  const core = createModularCore({
    dsh: scriptedDsh(onFollowup),
    onebot: {
      call: async (action, params) => {
        if (action === 'send_private_msg') {
          const text = (params.message || []).filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('')
          sent.push(text)
        }
        return { message_id: sent.length }
      },
    },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, sent }
}

let mid = 0
const privMsg = (text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text } }],
})

test('同 turn 内 steer 隔开的两段完整回复：两段都按顺序发到 QQ，不吞前一段', async () => {
  const { core, sent } = makeHarness(async ({ turn, emit }) => {
    emit({ type: 'user/message', data: { role: 'user', source: { kind: 'qq-hub' }, content: [{ type: 'text', text: '第一句' }] } })
    emit({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: '行吧 那我精神上支持你|||去喝口水顶顶饿也行' }] } } })
    emit({ type: 'user/message', data: { role: 'user', source: { kind: 'qq-hub' }, content: [{ type: 'text', text: '补一句' }] } })
    emit({ type: 'assistant/message', data: { turn, step: 2, message: { content: [{ type: 'text', text: '别傻眼了|||快找点吃的去吧' }] } } })
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  })
  try {
    await core.dispatchLegacyEvent(privMsg('不就是因为没米才扯吗'))
    await until(() => sent.length >= 4)
    assert.deepEqual(sent, ['行吧 那我精神上支持你', '去喝口水顶顶饿也行', '别傻眼了', '快找点吃的去吧'])
  } finally {
    await core.dispose()
  }
})

test('含 tool-call 的前置步即使后面有 steer 也不把工具铺垫拼进最终回复', async () => {
  const { core, sent } = makeHarness(async ({ turn, emit }) => {
    emit({
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '我先查一下' },
            { type: 'tool-call', id: 'tc1', name: 'qq_get_profile', input: {} },
          ],
        },
      },
    })
    emit({ type: 'user/message', data: { role: 'user', source: { kind: 'qq-hub' }, content: [{ type: 'text', text: '顺便看下签名' }] } })
    emit({ type: 'assistant/message', data: { turn, step: 2, message: { content: [{ type: 'text', text: '查好了，签名还是老样子' }] } } })
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  })
  try {
    await core.dispatchLegacyEvent(privMsg('帮我看下资料'))
    await sleep(120)
    assert.deepEqual(sent, ['查好了，签名还是老样子'])
  } finally {
    await core.dispose()
  }
})

test('runtime-context 的 user/message 不算用户 steer，不重复拼接前一步', async () => {
  const { core, sent } = makeHarness(async ({ turn, emit }) => {
    emit({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: '旧草稿' }] } } })
    emit({ type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '<ctx/>' }] } })
    emit({ type: 'assistant/message', data: { turn, step: 2, message: { content: [{ type: 'text', text: '最终回复' }] } } })
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  })
  try {
    await core.dispatchLegacyEvent(privMsg('测试'))
    await sleep(120)
    assert.deepEqual(sent, ['最终回复'])
  } finally {
    await core.dispose()
  }
})
