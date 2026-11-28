// Batch 3 · T3.10：会话模型决定视觉能力 / 附件登记顺序 / 群配额并发 / token 账本跨日与恢复
//
// 全部真实构造模块并观察行为（不写「读源码正则」测试）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createInboundVision } from '../src/chat/inbound-vision.js'
import { createInboundImages } from '../src/chat/inbound-images.js'
import { createGroupQuota } from '../src/chat/group-quota.js'
import { createTokenLedger } from '../src/chat/token-ledger.js'
import { askModel, clearReasoningCache, clearVisionCache } from '../src/core/llm.js'

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log }

/** 元数据：b3-vision 支持 image，其余只支持 text。 */
function visionDsh() {
  return {
    get: (n) => (n === 'llm' ? undefined : undefined),
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, inputModalities: model === 'b3-vision' ? ['text', 'image'] : ['text'] }
      },
    },
  }
}

function fakeImages() {
  const state = { admitted: 0, reads: 0 }
  return {
    state,
    module: {
      async admit(content) { state.admitted++; return content },
      async read(block) {
        state.reads++
        if (block.url === 'bad') throw new Error('下载失败')
        return { data: 'AAAA', mediaType: 'image/png' }
      },
    },
  }
}

const CFG_TEXT_DEFAULT = { model: { provider: 'b3p', model: 'b3-text' }, visionHelper: { enabled: false } }

test('T3.10 视觉判定跟随会话 target：默认模型能看图、会话模型不能 → 走转述不发图', async () => {
  clearVisionCache()
  const images = fakeImages()
  const vision = createInboundVision({ dsh: visionDsh(), log, inboundImages: images.module })
  const content = [{ type: 'text', text: '看这个' }, { type: 'image', url: 'https://x/a.png' }]
  const out = await vision.admit(content, {
    nickname: '小明', cfg: CFG_TEXT_DEFAULT, target: { provider: 'b3p', model: 'b3-text' },
  })
  assert.equal(images.state.admitted, 0, '会话模型看不了图：不许再把图片交给附件服务')
  assert.equal(out.some((b) => b.type === 'image'), false)
  assert.match(out.map((b) => b.text).join('\n'), /看不了图/)
})

test('T3.10 视觉判定跟随会话 target：默认模型不能看图、会话模型能 → 图片照发', async () => {
  clearVisionCache()
  const images = fakeImages()
  const vision = createInboundVision({ dsh: visionDsh(), log, inboundImages: images.module })
  const content = [{ type: 'text', text: '看这个' }, { type: 'image', url: 'https://x/a.png' }]
  const out = await vision.admit(content, {
    nickname: '小明', cfg: CFG_TEXT_DEFAULT, target: { provider: 'b3p', model: 'b3-vision' },
  })
  assert.equal(images.state.admitted, 1, '会话模型能看图：正常交给附件服务')
  assert.equal(out.some((b) => b.type === 'image'), true)
})

test('T3.10 面板 vision=off 优先于会话模型元数据', async () => {
  clearVisionCache()
  const images = fakeImages()
  const vision = createInboundVision({ dsh: visionDsh(), log, inboundImages: images.module })
  const out = await vision.admit([{ type: 'image', url: 'https://x/a.png' }], {
    cfg: { model: { provider: 'b3p', model: 'b3-vision', vision: 'off' }, visionHelper: { enabled: false } },
    target: { provider: 'b3p', model: 'b3-vision' },
  })
  assert.equal(images.state.admitted, 0)
  assert.equal(out.some((b) => b.type === 'image'), false)
})

test('T3.10 全部图片下载失败：不再把原 content 交回 inboundImages 重下一遍', async () => {
  clearVisionCache()
  const images = fakeImages()
  const vision = createInboundVision({ dsh: visionDsh(), log, inboundImages: images.module })
  const out = await vision.admit(
    [{ type: 'text', text: '两张' }, { type: 'image', url: 'bad' }, { type: 'image', url: 'bad' }],
    { cfg: CFG_TEXT_DEFAULT, target: { provider: 'b3p', model: 'b3-text' } },
  )
  assert.equal(images.state.reads, 2, '每张只读一次（不再整段回落重读）')
  assert.equal(images.state.admitted, 0, '不许回落 inboundImages.admit 再走一遍下载')
  assert.equal(out.filter((b) => b.type === 'image').length, 0)
  assert.equal(out.filter((b) => /没能把它下载下来/.test(b.text || '')).length, 2, '每张各给一个占位')
})

test('T3.10 inbound-images.load 拒绝非图片字节（HTML 错误页不许当图发给模型）', async () => {
  const html = Buffer.from('<!doctype html><html><body>login required</body></html>')
  const module = createInboundImages({
    log,
    onebot: { call: async () => ({ base64: html.toString('base64') }) },
    dsh: { get: () => null },
  })
  const got = await module.load({ chatId: 'g1', images: [{ type: 'image', data: { file: 'x' } }] })
  assert.equal(got.images.length, 0)
  assert.equal(got.failed, 1)
})

test('T3.10 askModel：先判「看不了图」再登记附件，不白等 admitPromptContent', async () => {
  clearReasoningCache()
  clearVisionCache()
  const prompts = []
  let admitCalls = 0
  const dsh = {
    get: (n) => (n === 'attachments' ? dsh.attachments : n === 'llm' ? dsh.llm : undefined),
    attachments: {
      async admitPromptContent(content) { admitCalls++; throw new Error('不该被调用') },
    },
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, inputModalities: ['text'] }
      },
      async *stream(params) { prompts.push(params); yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } },
    },
  }
  const text = await askModel(dsh, {
    cfg: { model: { provider: 'b3p', model: 'b3-text' }, visionHelper: { enabled: false } },
    text: '这图啥意思',
    images: [{ data: 'AAAA', mediaType: 'image/png' }],
  })
  assert.equal(text, 'ok')
  assert.equal(admitCalls, 0, '已经知道看不了图，就不该再碰附件服务')
  const sent = prompts[0].messages[0].content
  assert.equal(sent.every((b) => b.type === 'text'), true, '发给模型的是纯文字转述')
})

test('T3.10 群配额：同群并发 5 条，任意 60s 窗口内不超过上限', async () => {
  let t = 0
  const sends = []
  const quota = createGroupQuota({
    getConfig: () => ({ group: { quota: { enabled: true, perMinute: 3, reserve: 0, windowMs: 60000, retryWaitMs: 1000, maxRetries: 0 } } }),
    now: () => t,
    sleep: async (ms) => { t += ms },
    log,
  })
  await Promise.all([0, 1, 2, 3, 4].map((i) => quota.send('g1', async () => {
    sends.push({ i, at: t })
    return { ok: true }
  })))
  assert.equal(sends.length, 5)
  for (const anchor of sends) {
    const inWindow = sends.filter((s) => s.at - anchor.at >= 0 && s.at - anchor.at < 60000)
    assert.equal(inWindow.length <= 3, true, `窗口内发了 ${inWindow.length} 条，超过上限 3（${JSON.stringify(sends)}）`)
  }
})

test('T3.10 token 账本：跨日滚动后预算判定不再 fail-open', () => {
  const ledger = createTokenLedger({ today: '2026-01-01', budget: 1000 })
  ledger.allocate([{ chatKey: 'private:1', owner: true }], 1000)
  assert.equal(ledger.hasAllocation('2026-01-01'), true)
  // 跨日记账：rollTo 把 allocatedDay 同步到新的一天
  ledger.record('private:1', 10, { dateKey: '2026-01-02' })
  assert.equal(ledger.hasAllocation('2026-01-02'), true, '滚动到新的一天后仍算「已分配」')
  ledger.record('private:1', 600, { dateKey: '2026-01-02' })
  assert.equal(ledger.isExhausted('private:1', { dateKey: '2026-01-02' }), true, '超预算必须立刻熔断')
})

test('T3.10 token 账本 restore：群聊额度恢复成 group 等级，快照日期口径一致', () => {
  const day = '2026-02-03'
  const a = createTokenLedger({ today: day, budget: 2000 })
  a.allocate([{ chatKey: 'group:99', whitelisted: true }, { chatKey: 'private:1', owner: true }], 2000)
  const snap = a.snapshot()
  assert.equal(snap.dateKey, day)
  const b = createTokenLedger({ today: day, budget: 2000 })
  assert.equal(b.restore(snap), true)
  assert.equal(b.quotaOf('group:99').tier, 'group', '群聊不能因为恢复而变成主人额度')
  assert.equal(b.quotaOf('private:1').tier, 'owner')
})
