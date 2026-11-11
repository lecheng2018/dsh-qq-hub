import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const OWNER = '10000001'
const BOT = '20000002'
const TOKEN = 'panel-test-secret'

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqhub-sensitive-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  const mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: false, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    bridge: { http: true, token: TOKEN },
  }))
  const fake = createFakeDsh()
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  await api.ready
  return { fake, mock, api }
}

test('敏感接口不返回 SnowLuma 或 bridge 明文密钥', async () => {
  const { fake, mock } = await fixture()
  try {
    const pw = await fake.call('/snowluma/password')
    assert.equal(pw.status, 200)
    assert.equal('password' in pw.json(), false)
    const token = await fake.call('/bridge/token')
    assert.equal(token.status, 200)
    assert.equal(JSON.stringify(token.json()).includes(TOKEN), false)
    const examples = await fake.call('/bridge/examples')
    assert.equal(JSON.stringify(examples.json()).includes(TOKEN), false)
  } finally { fake.dispose(); await mock.close() }
})
