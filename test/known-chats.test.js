// /panel/chats 的数据来源：必须能从 sessions.json 真读出群和私聊。
// 这是「按聊天换人设」下拉的数据源；它返回空，面板就只能靠手输号码。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
let tmp

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qqhub-knownchats-'))
  process.env.DSH_QQ_HUB_DATA_DIR = tmp
  // 模拟真实数据：两个群、两个私聊
  writeFileSync(join(tmp, 'sessions.json'), JSON.stringify({
    chats: {
      'group:333444555': { sessionId: 's1', preset: 'x', level: 'social', createdAt: 300, title: 'QQ 群 · 老名字' },
      'group:987654321': { sessionId: 's2', preset: 'x', level: 'social', createdAt: 100, title: 'QQ 群 · 987654321' },
      'private:10000001': { sessionId: 's3', preset: 'x', level: 'chat', createdAt: 200, title: 'QQ · 主人私聊' },
      'system:diary': { sessionId: 's4', preset: 'x', level: 'chat', createdAt: 50, title: 'QQ · 后台' },
    },
  }), 'utf8')
})

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) {} })

test('knownChats 从 sessions.json 读出群和私聊，排除 system 会话', async () => {
  const { createHub } = await import(`file:///${REPO}/src/chat/hub.js`)
  const hub = createHub({
    dsh: { get: () => null, llm: null },
    getConfig: () => ({ ownerQQ: '10000001', ownerName: '主人', model: {}, group: {}, merge: {}, voice: {} }),
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
    onebot: null, stickers: null, tts: null,
    buildTools: () => [], contextProviders: [], onActivity: () => {},
    memoryScore: () => 0, onCommand: () => {}, isMuted: () => false,
    moodEffects: () => null, localApi: null, hooks: {}, availableModels: () => [], toolsGeneration: () => 0,
  })
  assert.equal(typeof hub.knownChats, 'function', 'hub 必须暴露 knownChats')
  const list = hub.knownChats()
  assert.ok(Array.isArray(list), '必须返回数组')
  assert.equal(list.length, 3, '两个群 + 一个私聊，system 会话要排除')

  const kinds = list.map((x) => x.kind).sort()
  assert.deepEqual(kinds, ['group', 'group', 'private'])

  const g = list.find((x) => x.id === '333444555')
  assert.ok(g, '群 333444555 必须在列表里')
  assert.equal(g.chatId, 'group:333444555')
  // 按 createdAt 倒序：300 的群排第一
  assert.equal(list[0].id, '333444555', '最近的排前面')

  const pv = list.find((x) => x.id === '10000001')
  assert.ok(pv, '私聊 10000001 必须在列表里')
  assert.equal(pv.chatId, 'private:10000001')
})

test('sessions.json 不存在时返回空数组，不抛', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'qqhub-empty-'))
  const old = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = empty
  try {
    const { createHub } = await import(`file:///${REPO}/src/chat/hub.js`)
    const hub = createHub({
      dsh: { get: () => null, llm: null },
      getConfig: () => ({ ownerQQ: '1', model: {}, group: {}, merge: {}, voice: {} }),
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
      onebot: null, stickers: null, tts: null,
      buildTools: () => [], contextProviders: [], onActivity: () => {},
      memoryScore: () => 0, onCommand: () => {}, isMuted: () => false,
      moodEffects: () => null, localApi: null, hooks: {}, availableModels: () => [], toolsGeneration: () => 0,
    })
    const list = hub.knownChats()
    assert.deepEqual(list, [], '没有数据时返回空数组')
  } finally {
    process.env.DSH_QQ_HUB_DATA_DIR = old
    try { rmSync(empty, { recursive: true, force: true }) } catch (e) {}
  }
})
