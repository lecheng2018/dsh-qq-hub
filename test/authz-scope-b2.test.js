// Batch 2 / T2.4：跨会话画作解析、群管混合回合提权、表情保护与生图路径泄露。
// 全部用例都真实调用导出函数 / 模块 setup() 出来的工具。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { savePainting, rememberPainting, resolvePainting } from '../src/features/paintings.js'
import { createStickerStore } from '../src/features/stickers.js'
import groupAdmin from '../src/modules/group-admin/index.js'
import stickersModule from '../src/modules/stickers/index.js'

const log = { info() {}, warn() {}, debug() {}, error() {} }
const TMP = mkdtempSync(join(tmpdir(), 'b2-authz-'))
// 真的 PNG 头 + 宽高：表情库会校验图片，不要用随手拼的字节
const PNG = (() => {
  const b = Buffer.alloc(160)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(200, 16)
  b.writeUInt32BE(200, 20)
  b[40] = 7
  return b
})()

const originalDataDir = process.env.DSH_QQ_HUB_DATA_DIR
function useDataDir (dir) { process.env.DSH_QQ_HUB_DATA_DIR = dir }
after(() => {
  if (originalDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
  else process.env.DSH_QQ_HUB_DATA_DIR = originalDataDir
  rmSync(TMP, { recursive: true, force: true })
})

/** 用最小 api 桩真实跑模块 setup()，返回工具提供者。 */
function moduleProviders (mod, config) {
  const providers = []
  const noop = () => {}
  const api = new Proxy({
    core: {
      hub: config.hub || {},
      onebot: { call: async (action, params) => { (config.calls ||= []).push({ action, params }); return { ok: true } } },
      http: { body: async () => ({}), send: noop },
      groupRoles: config.groupRoles || { get: async () => null, peek: () => null, canManage: () => false, label: () => '' },
    },
    config: () => config.cfg,
    log,
    tool: (fn) => providers.push(fn),
    lazy: (name) => (name === 'group-roles'
      ? { get: async () => null, canManage: () => false, label: () => '' }
      : { addEvent: noop }),
  }, { get: (target, key) => (key in target ? target[key] : noop) })
  mod.setup(api, {})
  return providers
}

test('T2.4：resolvePainting 默认只认本会话记录，别名/文件名都不跨会话捞图', () => {
  useDataDir(TMP)
  try {
    const a = savePainting(PNG, '猫A')
    const b = savePainting(PNG, '猫B')
    assert.ok(a && b, '两张画都落盘了')
    rememberPainting('private:A', a)

    // 本会话：编号可用
    assert.equal(resolvePainting('private:A', '1')?.file, a.split('/').pop())
    // 别的会话：编号 / 别名 / 直呼文件名都拿不到
    assert.equal(resolvePainting('private:B', '1'), null)
    assert.equal(resolvePainting('private:B', 'latest'), null)
    assert.equal(resolvePainting('private:B', b.split('/').pop()), null)
    // 只有显式打开全局回退（主人私聊）才允许按「最新 / 文件名」取
    assert.ok(resolvePainting('private:B', 'latest', { allowGlobalFallback: true }))
    assert.ok(resolvePainting('private:B', b.split('/').pop(), { allowGlobalFallback: true }))
  } finally {
    if (originalDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = originalDataDir
  }
})

function groupAdminTool ({ hasOwner = true, allOwner = true } = {}) {
  const calls = []
  const cfg = { ownerQQ: '10001', dryRun: false, allow: { groups: ['20001', '20002'] } }
  const providers = moduleProviders(groupAdmin, {
    cfg,
    calls,
    hub: {
      turnHasOwner: () => hasOwner,
      turnSendersAllOwner: () => allOwner,
      groupName: async () => '测试群',
    },
  })
  const got = providers[0]({ chat: { kind: 'group', groupId: '20001', chatId: 'group:20001' }, level: 'group', sessionId: 's1' })
  const tool = (Array.isArray(got) ? got : [got]).find((t) => t.name === 'qq_group_admin')
  assert.ok(tool, 'qq_group_admin 已注册')
  return { tool, calls }
}

test('T2.4：主人说过话但还有别人说话（混合回合）不给群管权限', async () => {
  const { tool, calls } = groupAdminTool({ hasOwner: true, allOwner: false })
  const res = await tool.execute({ action: 'kick', user_id: '30001' }, {})
  assert.equal(res.ok, false)
  assert.match(res.message, /只有主人/)
  assert.equal(calls.length, 0, '不能真的调用网关')
})

test('T2.4：群里只能操作当前群，跨群参数被拒', async () => {
  const { tool, calls } = groupAdminTool()
  const res = await tool.execute({ action: 'kick', group_id: '20002', user_id: '30001' }, {})
  assert.equal(res.ok, false)
  assert.match(res.message, /只能操作当前这个群/)
  assert.equal(calls.length, 0)
})

test('T2.4：禁言时长做合法钳制（防 Infinity / 负数）', async () => {
  const { tool, calls } = groupAdminTool()
  const res = await tool.execute({ action: 'ban', user_id: '30001', minutes: 1e9 }, {})
  assert.equal(res.ok, true, JSON.stringify(res))
  const ban = calls.find((c) => c.action === 'set_group_ban')
  assert.ok(ban, '确实调了禁言')
  assert.equal(ban.params.duration, 43200 * 60)
  const neg = groupAdminTool()
  await neg.tool.execute({ action: 'ban', user_id: '30001', minutes: -5 }, {})
  assert.equal(neg.calls[0].params.duration, 60, '负数按下限 1 分钟处理')
})

test('T2.4：空头衔 / 空公告被拒', async () => {
  const { tool, calls } = groupAdminTool()
  assert.equal((await tool.execute({ action: 'title', user_id: '30001', text: '   ' }, {})).ok, false)
  assert.equal((await tool.execute({ action: 'notice', text: '' }, {})).ok, false)
  assert.equal(calls.length, 0)
})

test('T2.4：主人加的表情，混合回合不能改名/改标签，全场主人的回合可以', async () => {
  const dir = mkdtempSync(join(TMP, 'stickers-'))
  useDataDir(dir)
  try {
    const cfg = { dryRun: true, stickers: { enabled: true, collect: true, caption: false } }
    const seed = createStickerStore({ dsh: {}, getConfig: () => cfg, onebot: { call: async () => ({}) }, log })
    const added = await seed.addFromBuffer(PNG, { name: '旧名', from: 'manual', toQQ: false })
    assert.equal(added.ok, true, JSON.stringify(added))

    const providers = moduleProviders(stickersModule, {
      cfg,
      hub: { turnHasOwner: () => true, turnSendersAllOwner: () => false, sendSticker: async () => true },
    })
    const tools = providers[0]({ chat: { kind: 'group', groupId: '20001', chatId: 'group:20001' }, level: 'group', sessionId: 's1' })
    const edit = tools.find((t) => t.name === 'qq_edit_sticker')
    assert.ok(edit, 'qq_edit_sticker 已注册')
    const denied = await edit.execute({ sticker: '旧名', new_name: '新名' }, {})
    assert.equal(denied.ok, false, `混合回合不该改：${JSON.stringify(denied)}`)
    assert.match(denied.message, /主人/)

    const providers2 = moduleProviders(stickersModule, {
      cfg,
      hub: { turnHasOwner: () => true, turnSendersAllOwner: () => true, sendSticker: async () => true },
    })
    const tools2 = providers2[0]({ chat: { kind: 'private', userId: '10001', chatId: 'private:10001' }, level: 'full', sessionId: 's2' })
    const edit2 = tools2.find((t) => t.name === 'qq_edit_sticker')
    const allowed = await edit2.execute({ sticker: '旧名', new_name: '新名' }, {})
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    const lib = seed.library()
    assert.ok(lib.items.some((i) => i.name === '新名'), '改名真的落库')
  } finally {
    if (originalDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = originalDataDir
  }
})
