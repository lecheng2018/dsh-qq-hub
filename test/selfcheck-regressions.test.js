import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHub } from '../src/chat/hub.js'
import { createChatLog, createChatLogApi } from '../src/chat/chat-log.js'
import { createMemoryStore } from '../src/features/memory.js'
import { normalize } from '../src/core/config.js'

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log }

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-selfcheck-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.AURABOT_DATA_DIR
      else process.env.AURABOT_DATA_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    })
}

test('聊天流水：调用方漏昵称时按主人名或 uid 兜底，不再写空 who', async () => {
  await withDataDir(() => {
    const cfg = normalize({ ownerQQ: '10000001', ownerName: '主人' })
    const hub = createHub({
      dsh: {}, getConfig: () => cfg, log, onebot: {}, stickers: {}, tts: {},
      chatLog: createChatLogApi(createChatLog({ getConfig: () => cfg, log })),
      buildTools: () => [], contextProviders: [], onActivity: () => {}, memoryScore: () => 0,
      onCommand: async () => null, isMuted: () => false,
      localApi: null, hooks: {}, availableModels: () => [], toolsGeneration: () => 0,
    })
    hub.logChat('private:10000001', '', '私回答案', '10000001')
    hub.logChat('group:777', '', '群友答案', '30003')
    const day = hub.chatLogDays()[0]
    const rows = hub.chatLogOf(day)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].who, '主人')
    assert.equal(rows[1].who, '30003')
  })
})
