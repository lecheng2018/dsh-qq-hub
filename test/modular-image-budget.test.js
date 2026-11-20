// 图片进历史的预算（feat/image-history-budget）：
// 服务端对「会话累计上下文 + 图片字节」有硬上限（真机 413 plugin_request_too_large：
// 请求约 5.8 MiB / 插件内存上限 64 MiB）。图片块一旦进历史，之后每一轮都会重新发一遍，
// 所以额度按会话累加：超出的新图不再进上下文，只留一句占位文字。
//
// 断言面（走真实入口 dispatchLegacyEvent）：
//   1. 张数额度：maxImages=2 时一轮 3 张图只进去 2 张，且补一句占位文字；
//   2. 跨轮累计：第一轮用掉 2 张后，第二轮再发 1 张 —— 不进上下文（额度已满，不是每轮重置）；
//   3. 关掉开关（enabled=false）：3 张全进（旧行为，面板可退）；
//   4. 换会话（resetChat）后额度归零：新会话又能看图（否则「重开」救不回来）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'
import { normalize } from '../src/core/config.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小 DSH：每轮把所有 image 块数出来，按「看到几张图」回一句文本。 */
function fakeDsh() {
  const listeners = new Set()
  const sessions = []
  const workspaces = [{ id: 'ws', path: 'ws' }]
  workspaces.archived = []
  const turns = []
  function makeAgent(id) {
    return {
      id,
      ctx: { get: () => null },
      followup(msg) {
        const images = (msg.content || []).filter((c) => c.type === 'image').length
        const texts = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        turns.push({ sessionId: id, images, texts, contentTypes: (msg.content || []).map((c) => c.type) })
        const session = { id }
        for (const fn of [...listeners]) {
          fn(session, { type: 'assistant/message', data: { turn: turns.length, message: { content: [{ type: 'text', text: `看到 ${images} 张图` }] } } })
          fn(session, { type: 'turn/end', data: { turn: turns.length, reason: { kind: 'completed' } } })
        }
        return Promise.resolve()
      },
    }
  }
  const ctrl = {
    create: async () => { const id = `sess-${sessions.length + 1}`; sessions.push(id); return { sessionId: id } },
    resolveAgent: async (id) => ({ agent: makeAgent(id) }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => workspaces, create: async () => workspaces[0], archiveSession: (id) => workspaces.archived.push(id) }
      if (name === 'attachments') return { admitPromptContent: async (content) => content.map((c) => c.type === 'image' ? { type: 'image', attachment: { attachmentId: 'a' }, mediaType: c.mediaType } : c) }
      return null
    },
  }
  return { ctx, sessions, workspaces, turns }
}

function mkCore(dshRaw, cfgOver = {}) {
  const cfg = {
    ...normalize({ botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', model: { vision: 'on' } }),
    enabled: true, dryRun: false,
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    // 合流窗口压到最短：本文件只关心「图片有几张进上下文」，不想等默认的 2.5s 窗
    merge: { waitSec: 0.02, maxSec: 0.1, groupWaitSec: 0.02, groupMaxSec: 0.1 },
    ...cfgOver,
  }
  if (cfgOver.imageBudget) cfg.imageBudget = { ...normalize({}).imageBudget, ...cfgOver.imageBudget }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: { call: async () => ({ message_id: '1' }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, cfg }
}

// 1x1 透明 PNG：image 段必须能在本机下载到字节（inbound-images 会真的去取图），
// 用 base64:// 内联就不用联网，测试才能脱网跑。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// 大图：合法 PNG 头 + 填充字节，用来压字节额度（mimeOf 只认魔数，不校验完整性）
const bigPngBase64 = (bytes) => {
  const head = Buffer.from(PNG_1PX, 'base64')
  const buf = Buffer.alloc(Math.max(head.length, bytes))
  head.copy(buf)
  return buf.toString('base64')
}

let mid = 0
const msgWithImages = (n, extra = {}, dataUrl = `base64://${PNG_1PX}`) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [
    { type: 'text', data: { text: '看看这几张' } },
    ...Array.from({ length: n }, (_, i) => ({ type: 'image', data: { url: dataUrl, file: `${mid}-${i}.png` } })),
  ],
  ...extra,
})

test('图片预算：张数额度用完的新图不进上下文，只留占位文字', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { imageBudget: { maxImages: 2, maxMiB: 12 } })
  try {
    await core.dispatchLegacyEvent(msgWithImages(3))
    await sleep(600)
    assert.equal(dshRaw.turns.length, 1)
    assert.equal(dshRaw.turns[0].images, 2, 'maxImages=2：3 张里只进去 2 张')
    assert.match(dshRaw.turns[0].texts, /1 张图没带进上下文/, '补一句占位文字，别让模型以为图是空白的')
  } finally { await core.dispose() }
})

test('图片预算：额度按会话累计，不是每轮重置', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { imageBudget: { maxImages: 2, maxMiB: 12 } })
  try {
    await core.dispatchLegacyEvent(msgWithImages(2))
    await sleep(600)
    assert.equal(dshRaw.turns[0].images, 2, '第一轮用掉全部 2 张额度')
    await core.dispatchLegacyEvent(msgWithImages(1))
    await sleep(600)
    assert.equal(dshRaw.turns[1].images, 0, '第二轮额度已满：新图不进上下文')
    assert.match(dshRaw.turns[1].texts, /1 张图没带进上下文/)
  } finally { await core.dispose() }
})

test('图片预算：enabled=false 时回到旧行为（一轮 3 张全进）', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { imageBudget: { enabled: false, maxImages: 2, maxMiB: 12 } })
  try {
    await core.dispatchLegacyEvent(msgWithImages(3))
    await sleep(600)
    assert.equal(dshRaw.turns[0].images, 3, '开关关掉 = 老行为，一张不裁')
    assert.doesNotMatch(dshRaw.turns[0].texts, /没带进上下文/)
  } finally { await core.dispose() }
})

test('图片预算：换会话后额度归零（重开就能重新看图）', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { imageBudget: { maxImages: 2, maxMiB: 12 } })
  try {
    await core.dispatchLegacyEvent(msgWithImages(2))
    await sleep(600)
    assert.equal(dshRaw.turns[0].images, 2)
    core.resetChat('private:10000001')
    await sleep(50)
    await core.dispatchLegacyEvent(msgWithImages(2))
    await sleep(600)
    assert.equal(dshRaw.turns[1].images, 2, '新会话额度重新给满（否则重开也救不回来）')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2')
  } finally { await core.dispose() }
})

test('图片预算：字节额度同样生效（单张超大图直接不进）', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { imageBudget: { maxImages: 24, maxMiB: 1 } })
  try {
    // 1.5 MB 原始字节 > 1 MiB 额度：这张图不该进上下文
    await core.dispatchLegacyEvent(msgWithImages(1, {}, `base64://${bigPngBase64(1_500_000)}`))
    await sleep(600)
    assert.equal(dshRaw.turns[0].images, 0, '超过字节额度的大图不进上下文')
    assert.match(dshRaw.turns[0].texts, /1 张图没带进上下文/)
  } finally { await core.dispose() }
})