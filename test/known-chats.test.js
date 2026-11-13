// /panel/chats 的数据来源：当前 SessionRegistry 从会话映射读出群和私聊。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModularCore } from '../src/host/modular-core.js'

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
let tmp

function currentCore(sessionStoreFile) {
  return createModularCore({
    dsh: { get: () => null, on: () => () => {} },
    onebot: { call: async () => ({}) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => ({ ownerQQ: '10000001', ownerName: '主人', model: {}, group: {}, merge: {}, voice: {} }),
    logger: log,
    log,
    sessionStoreFile,
  })
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qqhub-knownchats-'))
  process.env.DSH_QQ_HUB_DATA_DIR = tmp
  writeFileSync(join(tmp, 'sessions.json'), JSON.stringify({
    chats: {
      'group:333444555': { sessionId: 's1', preset: 'x', level: 'social', createdAt: 300, title: 'QQ 群 · 老名字' },
      'group:987654321': { sessionId: 's2', preset: 'x', level: 'social', createdAt: 100, title: 'QQ 群 · 987654321' },
      'private:10000001': { sessionId: 's3', preset: 'x', level: 'chat', createdAt: 200, title: 'QQ · 主人私聊' },
      'system:diary': { sessionId: 's4', preset: 'x', level: 'chat', createdAt: 50, title: 'QQ · 后台' },
    },
  }), 'utf8')
})

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('knownChats 从当前会话映射读出群和私聊，排除 system 会话', async () => {
  const core = currentCore(join(tmp, 'sessions.json'))
  try {
    const list = core.knownChats()
    assert.ok(Array.isArray(list), '必须返回数组')
    assert.equal(list.length, 3, '两个群 + 一个私聊，system 会话要排除')
    assert.deepEqual(list.map((x) => x.kind).sort(), ['group', 'group', 'private'])
    const g = list.find((x) => x.id === '333444555')
    assert.ok(g, '群 333444555 必须在列表里')
    assert.equal(g.chatId, 'group:333444555')
    assert.equal(list[0].id, '333444555', '最近的排前面')
    const pv = list.find((x) => x.id === '10000001')
    assert.ok(pv, '私聊 10000001 必须在列表里')
    assert.equal(pv.chatId, 'private:10000001')
  } finally { await core.dispose() }
})

test('会话映射不存在时返回空数组，不抛', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'qqhub-empty-'))
  const old = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = empty
  const core = currentCore(join(empty, 'sessions.json'))
  try {
    assert.deepEqual(core.knownChats(), [])
  } finally {
    await core.dispose()
    process.env.DSH_QQ_HUB_DATA_DIR = old
    try { rmSync(empty, { recursive: true, force: true }) } catch {}
  }
})
