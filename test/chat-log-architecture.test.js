import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path) => readFileSync(join(root, path), 'utf8')

test('host owns retention while modules receive the independent, narrow chatLog API', () => {
  const host = source('src/host.js')
  const hub = source('src/chat/hub.js')
  assert.match(host, /createChatLogApi\(chatLogStore\)/)
  assert.match(host, /chatLogStore\.startRetention\(\)/)
  assert.match(host, /const core = \{\s*hub, chatLog,/)
  assert.match(host, /logChat: .*chatLog\.append/)
  assert.match(hub, /resolveChatOfSession, chatLog[,}]/)
  assert.match(hub, /chatLog\?\.append/)
  assert.doesNotMatch(hub, /deleteChatLog/)

  const modules = [
    'src/modules/memory/index.js',
    'src/modules/distill/index.js',
    'src/modules/slang/index.js',
    'src/modules/token-guardian/index.js',
    'src/modules/purpose/index.js',
    'src/modules/diary/index.js',
    'src/modules/qzone-social/index.js',
    'src/modules/bili/index.js',
  ]
  for (const path of modules) assert.match(source(path), /chatLog/ , `${path} receives the chatLog service`)
})
