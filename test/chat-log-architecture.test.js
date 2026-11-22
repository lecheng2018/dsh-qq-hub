import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path) => readFileSync(join(root, path), 'utf8')

test('host owns retention while modules receive the independent, narrow chatLog API', () => {
  const host = source('src/host.js')
  const hub = source('src/host/current-hub.js')
  assert.match(host, /createChatLogApi\(chatLogStore\)/)
  assert.match(host, /chatLogStore\.startRetention\(\)/)
  assert.match(host, /const core = \{\s*hub, chatLog,/)
  assert.match(host, /logChat: .*chatLog\.append/)
  assert.match(hub, /function logChat\(/)
  assert.match(hub, /chatLog\?\.append/)
  assert.doesNotMatch(hub, /deleteChatLog/)

  // qzone-social 仍在包内；bili 1.2.0 起整包搬到商店模块（那边的 duty.mjs 接收 chatLog）
  const modules = [
    'src/modules/memory/index.js',
    'src/modules/token-guardian/index.js',
    'src/modules/purpose/index.js',
    'src/modules/diary/index.js',
    'src/features/qzone-social.js',
  ]
  for (const path of modules) assert.match(source(path), /chatLog/ , `${path} receives the chatLog service`)
})
