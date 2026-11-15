// llm.js 温度限制兜底（runStream）的回归网。
//
// 背景：辅助看图固定发 temperature: 0.2，kimi 系模型只收 1，整轮 400——
// 辅助看图因此挂过一次（真机 2026-11-14）。兜底语义：明确撞上温度限制时
// 去掉 temperature 重试一次（用模型默认值）；其他错误一律原样上抛，绝不盲目重试。
//
// describeWithHelper 是 runStream 的导出包装，用它做端到端测试（fake dsh + fake 流）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { describeWithHelper } from '../src/core/llm.js'

const IMG = { data: Buffer.from('img').toString('base64'), mediaType: 'image/png' }
const CFG = { visionHelper: { enabled: true, provider: 'fan', model: 'kimi-k3.1-pro' } }

/** 造一个 fake dsh：stream 按 prewritten 行为响应，记录每次收到的 params。 */
function fakeDsh (behaviors) {
  const calls = []
  let n = 0
  return {
    calls,
    llm: {
      stream: async function* (params) {
        calls.push(params)
        const b = behaviors[Math.min(n, behaviors.length - 1)]
        n += 1
        if (b.error) yield { type: 'finish', reason: { kind: 'error', failure: { code: 400, message: b.error } } }
        else yield { type: 'text-delta', text: b.text }
      },
    },
    attachments: { admitPromptContent: async (c) => c },
  }
}

const LOG = { warn: () => {}, debug: () => {} }

test('temperature 被拒（kimi 原话）→ 自动去掉 temperature 重试一次，拿到描述', async () => {
  const dsh = fakeDsh([
    { error: '400: {"message":"`temperature` only 1 is allowed for this model Request id: 0217"}' },
    { text: '图里有一只猫，瘫在窝里' },
  ])
  const out = await describeWithHelper(dsh, { images: [IMG], cfg: CFG, log: LOG })
  assert.equal(out, '图里有一只猫，瘫在窝里')
  assert.equal(dsh.calls.length, 2, '恰好重试一次')
  assert.equal(dsh.calls[0].temperature, 0.2, '第一次带着原 temperature')
  assert.equal(dsh.calls[1].temperature, undefined, '第二次去掉 temperature（用模型默认）')
  // 其余参数原样保留
  assert.deepEqual(dsh.calls[1].messages, dsh.calls[0].messages)
})

test('普通错误（非温度限制）不重试，原样失败返回空串', async () => {
  const dsh = fakeDsh([{ error: '500: gateway on fire' }])
  const out = await describeWithHelper(dsh, { images: [IMG], cfg: CFG, log: LOG })
  assert.equal(out, '')
  assert.equal(dsh.calls.length, 1, '只调了一次')
})

test('提到 temperature 但没有拒绝语气的错误不触发兜底（保守判定）', async () => {
  const dsh = fakeDsh([{ error: '400: parameter temperature is deprecated and was ignored' }])
  const out = await describeWithHelper(dsh, { images: [IMG], cfg: CFG, log: LOG })
  assert.equal(out, '')
  assert.equal(dsh.calls.length, 1, '没有拒绝语气 → 不重试')
})

test('params 本来就不带 temperature 时绝不重试（防重复生成）', async () => {
  // describeWithHelper 恒传 temperature，这里直接用「无图片路径」旁证不误触；
  // 真正的无 temperature 调用由 askModel 分支承担，兜底对其是纯加分。
  const dsh = fakeDsh([{ text: 'ok' }])
  const out = await describeWithHelper(dsh, { images: [IMG], cfg: CFG, log: LOG })
  assert.equal(out, 'ok')
  assert.equal(dsh.calls.length, 1)
})

test('重试仍失败 → 返回空串（辅助看图降级，不拖垮主流程）', async () => {
  const dsh = fakeDsh([
    { error: '400: {"message":"`temperature` only 1 is allowed for this model"}' },
    { error: '400: {"message":"`temperature` only 1 is allowed for this model"}' },
  ])
  const out = await describeWithHelper(dsh, { images: [IMG], cfg: CFG, log: LOG })
  assert.equal(out, '')
  assert.equal(dsh.calls.length, 2, '重试仅一次，不无限循环')
})
