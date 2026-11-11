import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const OWNER = '10000001'
const BOT = '20000002'
const TOKEN = 'panel-admin-test-secret'

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqhub-admin-auth-'))
  const prevDataDir = process.env.AURABOT_DATA_DIR
  const prevWorkspace = process.env.AURABOT_WORKSPACE
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
  return {
    dataDir,
    fake,
    mock,
    api,
    async dispose() {
      fake.dispose()
      await mock.close()
      if (prevDataDir === undefined) delete process.env.AURABOT_DATA_DIR
      else process.env.AURABOT_DATA_DIR = prevDataDir
      if (prevWorkspace === undefined) delete process.env.AURABOT_WORKSPACE
      else process.env.AURABOT_WORKSPACE = prevWorkspace
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('面板管理接口无需联动密钥；开放接口仍要求密钥', async () => {
  const f = await fixture()
  try {
    const workspace = await f.fake.ctx.workspaceRegistry.create(join(f.dataDir, 'ws', 'delete-me'), 'delete-me')
    const registry = f.fake.ctx.workspaceRegistry
    registry.delete = (id) => {
      const index = f.fake.workspaces.findIndex((w) => w.id === id)
      if (index >= 0) f.fake.workspaces.splice(index, 1)
    }
    const moduleDir = join(f.dataDir, 'modules', 'admin-auth-regression')

    const moduleWrite = await f.fake.call('/ext/echo/write', {})
    assert.notEqual(moduleWrite.status, 401, '模块前缀写路由不再要求管理密钥')

    const saved = await f.fake.call('/save', { ownerName: 'panel-user' })
    assert.equal(saved.status, 200)
    assert.equal(f.api.getConfig().ownerName, 'panel-user')

    const created = await f.fake.call('/modules/create', { id: 'admin-auth-regression', name: 'panel-user' })
    assert.equal(created.status, 200)
    assert.equal(created.json().ok, true)
    assert.equal(existsSync(moduleDir), true)

    const deleted = await f.fake.call('/workspaces/delete', { id: workspace.id })
    assert.equal(deleted.status, 200)
    assert.equal(f.fake.ctx.workspaceRegistry.list().some((w) => w.id === workspace.id), false)

    const read = await f.fake.call('/state')
    assert.equal(read.status, 200)
    assert.equal(read.json().ok, true)

    const protectedRead = await f.fake.call('/open/info')
    assert.equal(protectedRead.status, 401, '开放只读接口仍要求密钥')
    const authorizedRead = await f.fake.call('/open/info', undefined, { 'x-qq-hub-token': TOKEN })
    assert.equal(authorizedRead.status, 200)
    assert.equal(authorizedRead.json().ok, true)

    const reset = await f.fake.call('/bridge/token/reset', {})
    assert.equal(reset.status, 403, '面板仍不提供联动密钥轮换')
    assert.equal(f.api.getConfig().bridge.token, TOKEN)

    const csrf = await f.fake.call('/save', { ownerName: 'cross-site' }, { origin: 'http://evil.example' })
    assert.equal(csrf.status, 403, '移除面板密钥不影响 CSRF 防护')
    assert.equal(f.api.getConfig().ownerName, 'panel-user')
  } finally {
    await f.dispose()
  }
})

test('关闭开放接口不影响面板写操作或密码强度校验', async () => {
  const f = await fixture()
  try {
    await f.api.setConfig({ ...f.api.getConfig(), bridge: { ...f.api.getConfig().bridge, http: false } })
    const enabled = await f.fake.call('/save', { bridge: { http: true } })
    assert.equal(enabled.status, 200)
    assert.equal(f.api.getConfig().bridge.http, true)
    await f.api.setConfig({ ...f.api.getConfig(), bridge: { ...f.api.getConfig().bridge, http: false } })
    for (const path of ['/snowluma/set-password', '/snowluma/reset-password', '/save']) {
      const body = path === '/save' ? { snowluma: { webuiPassword: 'weak' } } : { password: 'weak' }
      const result = await f.fake.call(path, body)
      assert.notEqual(result.status, 401, `${path} 不再要求联动密钥`)
    }
    const open = await f.fake.call('/open/info')
    assert.equal(open.status, 401)
  } finally {
    await f.dispose()
  }
})

test('副作用路径仍拒绝 GET，合法只读 GET 不受影响', async () => {
  const f = await fixture()
  try {
    const before = f.api.getConfig().ownerName
    const writeAsGet = await f.fake.call('/save', undefined, {}, { method: 'GET' })
    assert.equal(writeAsGet.status, 405)
    assert.equal(f.api.getConfig().ownerName, before)

    const state = await f.fake.call('/state', undefined, {}, { method: 'GET' })
    assert.equal(state.status, 200)
  } finally {
    await f.dispose()
  }
})
