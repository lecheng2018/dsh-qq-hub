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

test('面板管理接口要求有效联动密钥；合法只读接口仍可匿名读取', async () => {
  const f = await fixture()
  try {
    const workspace = await f.fake.ctx.workspaceRegistry.create(join(f.dataDir, 'ws', 'delete-me'), 'delete-me')
    const registry = f.fake.ctx.workspaceRegistry
    registry.delete = (id) => {
      const index = f.fake.workspaces.findIndex((w) => w.id === id)
      if (index >= 0) f.fake.workspaces.splice(index, 1)
    }
    const moduleDir = join(f.dataDir, 'modules', 'admin-auth-regression')
    const configBefore = f.api.getConfig()

    for (const path of ['/save', '/modules/create', '/workspaces/delete']) {
      const body = path === '/save'
        ? { ownerName: 'unauthorized' }
        : path === '/modules/create'
          ? { id: 'admin-auth-regression', name: 'unauthorized' }
          : { id: workspace.id }
      const denied = await f.fake.call(path, body, {}, { admin: false })
      assert.equal(denied.status, 401, `${path}: 缺少密钥必须返回真实 HTTP 401`)
      const wrong = await f.fake.call(path, body, { 'x-qq-hub-token': 'wrong-secret' })
      assert.equal(wrong.status, 401, `${path}: 错误密钥必须返回真实 HTTP 401`)
    }
    const moduleWrite = await f.fake.call('/ext/echo/write', {}, {}, { admin: false })
    assert.equal(moduleWrite.status, 401, '模块前缀写路由同样要求管理密钥')
    const moduleWriteAuthorized = await f.fake.call('/ext/echo/write', {}, { 'x-qq-hub-token': TOKEN })
    assert.notEqual(moduleWriteAuthorized.status, 401)

    assert.equal(f.api.getConfig().ownerName, configBefore.ownerName, '/save 不应产生未授权配置变更')
    assert.equal(existsSync(moduleDir), false, '模块目录不应在未授权时创建')
    assert.ok(f.fake.ctx.workspaceRegistry.list().some((w) => w.id === workspace.id), '工作区不应在未授权时删除')

    const read = await f.fake.call('/state')
    assert.equal(read.status, 200)
    assert.equal(read.json().ok, true)

    const protectedRead = await f.fake.call('/open/info')
    assert.equal(protectedRead.status, 401, '原有受保护的只读开放接口必须保留鉴权和真实 401')
    const authorizedRead = await f.fake.call('/open/info', undefined, { 'x-qq-hub-token': TOKEN })
    assert.equal(authorizedRead.status, 200)
    assert.equal(authorizedRead.json().ok, true)

    const resetDenied = await f.fake.call('/bridge/token/reset', {}, {}, { admin: false })
    assert.equal(resetDenied.status, 401)
    assert.equal(f.api.getConfig().bridge.token, TOKEN, '未授权时不得旋转或签发密钥')
    const resetAuthorized = await f.fake.call('/bridge/token/reset', {}, { 'x-qq-hub-token': TOKEN })
    assert.equal(resetAuthorized.status, 403, '有效密钥也不能通过 API 轮换')
    assert.equal(f.api.getConfig().bridge.token, TOKEN)

    const csrf = await f.fake.call('/save', { ownerName: 'cross-site' }, {
      'x-qq-hub-token': TOKEN,
      origin: 'http://evil.example',
    })
    assert.equal(csrf.status, 403, '有效密钥不能绕过 CSRF 防护')
    assert.equal(f.api.getConfig().ownerName, configBefore.ownerName)

    const saved = await f.fake.call('/save', { ownerName: 'authorized' }, { 'x-qq-hub-token': TOKEN })
    assert.equal(saved.status, 200)
    assert.equal(f.api.getConfig().ownerName, 'authorized')

    const created = await f.fake.call('/modules/create', { id: 'admin-auth-regression', name: 'authorized' }, { 'x-qq-hub-token': TOKEN })
    assert.equal(created.status, 200)
    assert.equal(created.json().ok, true)
    assert.equal(existsSync(moduleDir), true)

    const deleted = await f.fake.call('/workspaces/delete', { id: workspace.id }, { 'x-qq-hub-token': TOKEN })
    assert.equal(deleted.status, 200)
    assert.equal(f.fake.ctx.workspaceRegistry.list().some((w) => w.id === workspace.id), false)
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
