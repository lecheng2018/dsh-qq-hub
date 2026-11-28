// Batch 2 / T2.3：发文件软链接穿透 + qq_set_avatar / 市场下载的 SSRF 闭环缺口。
// 全部用例真实调用 createOutboundFiles.sendFile 与 profile 模块 setup() 出来的工具。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOutboundFiles } from '../src/chat/outbound-files.js'
import profile from '../src/modules/profile/index.js'

const log = { info() {}, warn() {}, debug() {}, error() {} }
// 换头像成功路径会把图片落到插件数据目录，给一个真实临时目录（用完删）
const AVATAR_TMP = mkdtempSync(join(tmpdir(), 'b2-avatar-'))
after(() => rmSync(AVATAR_TMP, { recursive: true, force: true }))
const HUB_PREFIX = { chatOfSession: () => 'private:10001', turnSendersAllOwner: () => true, recentMedia: () => [] }

function outbound (cfg, calls = []) {
  const outbox = {
    request: async (req) => { calls.push(req); return { state: 'sent', raw: { ok: true } } },
  }
  const files = createOutboundFiles({
    getConfig: () => cfg,
    log,
    outbox,
    sendSegments: async () => ({}),
    captureOnly: () => null,
    onStats: () => {},
    deliveryContext: { getStore: () => null },
  })
  return { files, calls }
}

function baseCfg (dirs) {
  return { enabled: true, dryRun: false, files: { enabled: true, maxMB: 50, dirs } }
}

test('T2.3：工作区内指向区外的软链接被拒（realpath 判定，不再用字面路径）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-sym-'))
  try {
    const inside = join(root, 'inside')
    const outside = join(root, 'outside')
    mkdirSync(inside, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET')
    const link = join(inside, 'link.txt')
    symlinkSync(secret, link)

    const { files, calls } = outbound(baseCfg([inside]))
    await assert.rejects(() => files.sendFile('private:10001', link), /不在允许发送的目录里/)
    assert.equal(calls.length, 0, '被拒的软链接不能真的发给网关')

    // 对照：真实位于允许目录内的普通文件照常发
    const okFile = join(inside, 'ok.txt')
    writeFileSync(okFile, 'hello')
    await files.sendFile('private:10001', okFile)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].params.file, okFile)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('T2.3：外部 http(s) 文件先由插件侧安全下载，内网地址直接拒（不再丢给网关拉）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-ssrf-'))
  try {
    const { files, calls } = outbound(baseCfg([root]))
    await assert.rejects(() => files.sendFile('private:10001', 'http://127.0.0.1:13080/secret'), /发文件失败/)
    assert.equal(calls.length, 0, '内网地址不能被转发给 OneBot')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('T2.3：外部公网文件下载后以 base64:// 交给网关，原 URL 不外泄', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-ext-'))
  const originalFetch = globalThis.fetch
  try {
    // 公网字面 IP（assertPublicUrl 不做 DNS 查询），fetch 用桩返回图片字节
    const url = 'http://93.184.216.34/pic.png'
    globalThis.fetch = async () => new Response(Buffer.from('fake-image-bytes'), { status: 200, headers: { 'content-type': 'image/png' } })
    const { files, calls } = outbound(baseCfg([root]))
    await files.sendFile('private:10001', url)
    assert.equal(calls.length, 1)
    assert.match(String(calls[0].params.file), /^base64:\/\//, '交给网关的必须是已下载的字节')
    assert.doesNotMatch(String(calls[0].params.file), /93\.184\.216\.34/)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

/** 真实跑 profile 模块 setup()，取出 qq_set_avatar 工具。 */
function avatarTool (calls) {
  const providers = []
  const noop = () => {}
  const api = new Proxy({
    core: {
      hub: { ...HUB_PREFIX, sessions: () => ({}), sendSegments: async () => ({ message_id: 1 }) },
      onebot: { call: async (action, params) => { calls.push({ action, params }); return { ok: true } } },
    },
    config: () => ({ ownerQQ: '10001', dryRun: false, enabled: true, profilePerms: { qqAvatar: 'owner' } }),
    dataDir: (f) => join(AVATAR_TMP, f || ''),
    log,
    tool: (fn) => providers.push(fn),
    rule: noop,
    onDispose: noop,
  }, { get: (target, key) => (key in target ? target[key] : noop) })
  profile.setup(api, {})
  assert.equal(providers.length, 1, 'profile 只登记一个工具提供者')
  const list = providers[0]({ chat: { kind: 'private', userId: '10001', chatId: 'private:10001' }, sessionId: 's1' })
  const tool = list.find((t) => t.name === 'qq_set_avatar')
  assert.ok(tool, 'qq_set_avatar 已注册')
  return tool
}

test('T2.3：qq_set_avatar 内网网址被拒，且绝不把原始 URL 传给 OneBot', async () => {
  const calls = []
  const tool = avatarTool(calls)
  const res = await tool.execute({ image: 'http://127.0.0.1:13080/secret.png' }, {})
  assert.equal(res?.ok, false, `应失败，实际：${JSON.stringify(res)}`)
  assert.match(String(res?.message), /不能用|拿不到|无法|内网|私网|环回/)
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify(call.params), /127\.0\.0\.1/, '原始内网 URL 不能进 OneBot 请求')
  }
})

test('T2.3：qq_set_avatar 公网网址下载成功后以 base64 提交', async () => {
  const calls = []
  const tool = avatarTool(calls)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(Buffer.from('avatar-bytes'), { status: 200, headers: { 'content-type': 'image/png' } })
    const res = await tool.execute({ image: 'http://93.184.216.34/a.png' }, {})
    assert.notEqual(res?.ok, false, `应成功，实际：${JSON.stringify(res)}`)
    const setAvis = calls.filter((c) => c.action === 'set_qq_avatar')
    assert.ok(setAvis.length >= 1, '确实调用了 set_qq_avatar')
    assert.match(String(setAvis[0].params.file), /^base64:\/\//, '提交的必须是插件侧下载好的字节')
    assert.doesNotMatch(String(setAvis[0].params.file), /93\.184\.216\.34/)
  } finally { globalThis.fetch = originalFetch }
})
