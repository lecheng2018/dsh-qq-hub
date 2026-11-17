import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createModularCore } from '../src/host/modular-core.js'

const OWNER = '10000001'
const BOT = '20000002'
const OTHER = '30000003'
const TOKEN = 'panel-parity-test-token' /* pii-scan:ignore */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, message) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const value = predicate()
    if (value) return value
    await wait(20)
  }
  assert.fail(message)
}

function png(salt) {
  const b = Buffer.alloc(96)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(200, 16); b.writeUInt32BE(200, 20); b[40] = salt
  return b
}

function event({ group, user = OWNER, text = '在吗', sticker, id }) {
  const message = []
  if (group) message.push({ type: 'at', data: { qq: BOT } })
  message.push({ type: 'text', data: { text } })
  if (sticker) message.push({ type: 'image', data: { sub_type: 1, file: 'base64://' + sticker.toString('base64') } })
  return {
    message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
    ...(group ? { group_id: Number(group) } : {}), user_id: Number(user), message_id: id,
    sender: { user_id: Number(user), nickname: '测试者' }, message,
  }
}

let f
let messageId = 100

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-panel-parity-'))
  const keys = ['DSH_QQ_HUB_DATA_DIR', 'AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'FLAG_MODULAR_CORE']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'ws')
  process.env.FLAG_MODULAR_CORE = 'true'
  const mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, OTHER], groups: ['777', '778'] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dir, 'none') },
    bridge: { http: true, token: TOKEN },
    merge: { waitSec: 0.03, maxSec: 0.1, groupWaitSec: 0.03, groupMaxSec: 0.1 },
    group: { interjectChance: 0, quota: { enabled: false } },
    stickers: { enabled: true, collect: true, collectMode: 'ask', fromGroups: true, fromPrivate: true, autoChance: 0, caption: false },
  }))
  const fake = createFakeDsh({ brain: async ({ text, callTool }) => {
    if (text.includes('请挑一下')) await callTool('qq_collect_sticker', { index: 1, name: '测试表情' })
    return '好'
  } })
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  f = { dir, previous, mock, fake, api }
  await api.ready
  await fake.call('/onebot/reconnect', {})
  await until(() => mock.connected(), '本地假 OneBot 未连接')
})

test.afterEach(async () => {
  if (!f) return
  f.api.setConfig({ ...f.api.getConfig(), enabled: false })
  f.fake.dispose()
  await f.mock.close()
  for (const [key, value] of Object.entries(f.previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(f.dir, { recursive: true, force: true })
  f = null
})

async function send(options) {
  const id = ++messageId
  const before = f.fake.turns.length
  f.mock.push(event({ ...options, id }))
  await until(() => f.fake.turns.length > before, '消息未进入新核心回合')
  return f.fake.turns.at(-1)
}

function setStickers(patch) {
  const cfg = f.api.getConfig()
  f.api.setConfig({ ...cfg, stickers: { ...cfg.stickers, ...patch } })
}

test('ask 私聊只提示并暂存，工具选择后才入库', async () => {
  const turn = await send({ text: '请挑一下', sticker: png(1) })
  assert.match(turn.userText, /qq_collect_sticker/)
  const call = turn.toolCalls.find((item) => item.name === 'qq_collect_sticker')
  assert.equal(call?.result?.ok, true, JSON.stringify(call))
  assert.equal(f.api.stickers.library().items.length, 1)
  const stash = JSON.parse(readFileSync(join(f.dir, 'sticker-stash.json'), 'utf8'))
  assert.equal(stash[`private:${OWNER}`].segs.length, 1)
})

test('ask 群聊提示但不自动入库，工具可读取当前群候选', async () => {
  const turn = await send({ group: '777', user: OTHER, text: '看看这张', sticker: png(2) })
  assert.match(turn.userText, /qq_collect_sticker/)
  assert.match(turn.userText, /你自己的小爱好/)
  assert.equal(f.api.stickers.library().items.length, 0)
  assert.ok(f.api.hub.stickerOf('group:777', 1))
})

test('auto 模式严格遵循私聊和群来源开关与入站白名单', async () => {
  const collected = []
  const store = f.api.stickers
  const original = store.collect
  store.collect = async (seg, chatId) => { collected.push(chatId); return { ok: true } }
  try {
    setStickers({ collectMode: 'auto', fromPrivate: false, fromGroups: true })
    await send({ text: '私聊关闭', sticker: png(3) })
    await send({ group: '777', user: OTHER, text: '群聊开启', sticker: png(4) })
    assert.deepEqual(collected, ['group:777'])
    setStickers({ fromPrivate: true, fromGroups: false })
    await send({ text: '私聊开启', sticker: png(5) })
    await send({ group: '777', user: OTHER, text: '群聊关闭', sticker: png(6) })
    assert.deepEqual(collected, ['group:777', `private:${OWNER}`])
    setStickers({ fromGroups: true })
    f.mock.push(event({ group: '999', user: OTHER, sticker: png(7), id: ++messageId }))
    await wait(150)
    assert.deepEqual(collected, ['group:777', `private:${OWNER}`])
  } finally { store.collect = original }
})

test('面板立即应用模型同时覆盖新核心私聊和群会话', async () => {
  const privateTurn = await send({ text: '私聊会话' })
  const groupTurn = await send({ group: '777', user: OTHER, text: '群会话' })
  const cfg = f.api.getConfig()
  f.api.setConfig({ ...cfg, chatModels: { ...cfg.chatModels, privates: { [OWNER]: { provider: 'fake', model: 'm-owner' } }, groups: { 777: { provider: 'fake', model: 'm-g777' } } } })
  const start = f.fake.modelSelections.length
  const result = (await f.fake.call('/models/apply', {})).json()
  assert.equal(result.ok, true)
  assert.equal(result.applied, 2)
  const selections = f.fake.modelSelections.slice(start)
  assert.ok(selections.some((s) => s.agentId === privateTurn.sessionId && s.model === 'm-owner'))
  assert.ok(selections.some((s) => s.agentId === groupTurn.sessionId && s.model === 'm-g777'))
})

test('/save 切换按群人设仅归档受影响会话并在下一轮重建', async () => {
  await f.fake.call('/persona/save', { id: 'panel-other', name: '其他', body: '你是测试人格。' })
  const priv = await send({ text: '私聊初始' })
  const group = await send({ group: '777', user: OTHER, text: '群聊初始' })
  const saved = (await f.fake.call('/save', { persona: { groups: { 777: 'panel-other' } } })).json()
  assert.equal(saved.ok, true)
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(group.sessionId), '受影响的群会话应立即归档')
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(priv.sessionId), '未改变人设的私聊不能重置')
  const next = await send({ group: '777', user: OTHER, text: '切换后' })
  assert.notEqual(next.sessionId, group.sessionId)
  assert.match(next.persona, /测试人格/)
})

test('/persona/use 仅重置有效人设改变的会话，不重置已固定目标人设的会话', async () => {
  await f.fake.call('/persona/save', { id: 'panel-new', name: '新人格', body: '你是新的测试人格。' })
  await f.fake.call('/save', { persona: { groups: { 778: 'panel-new' } } })
  const priv = await send({ text: '跟随全局' })
  const pinned = await send({ group: '778', user: OTHER, text: '固定人设' })
  const used = (await f.fake.call('/persona/use', { id: 'panel-new' })).json()
  assert.equal(used.ok, true)
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(priv.sessionId), '跟随全局的旧会话应重置')
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(pinned.sessionId), '固定为目标人设的会话不应重置')
  const next = await send({ text: '新全局' })
  assert.notEqual(next.sessionId, priv.sessionId)
  assert.match(next.persona, /新的测试人格/)
})

test('ask 关闭来源时不提示、不创建候选', async () => {
  setStickers({ fromPrivate: false, fromGroups: false })
  const priv = await send({ text: '私聊关闭，请挑一下', sticker: png(8) })
  const group = await send({ group: '777', user: OTHER, text: '群聊关闭，请挑一下', sticker: png(9) })
  assert.doesNotMatch(priv.userText, /qq_collect_sticker/)
  assert.doesNotMatch(group.userText, /qq_collect_sticker/)
  assert.equal(priv.toolCalls.find((item) => item.name === 'qq_collect_sticker')?.result?.ok, false)
  assert.equal(group.toolCalls.find((item) => item.name === 'qq_collect_sticker')?.result?.ok, false)
  assert.equal(f.api.stickers.library().items.length, 0)
  assert.equal(f.api.hub.stickerOf(`private:${OWNER}`, 1), null)
  assert.equal(f.api.hub.stickerOf('group:777', 1), null)
  assert.equal(existsSync(join(f.dir, 'sticker-stash.json')), false)
})

test('owner 模式只提示主人，非主人不能借工具入库', async () => {
  setStickers({ collectMode: 'owner' })
  const other = await send({ group: '777', user: OTHER, text: '请挑一下', sticker: png(10) })
  assert.doesNotMatch(other.userText, /qq_collect_sticker/)
  const denied = other.toolCalls.find((item) => item.name === 'qq_collect_sticker')
  assert.equal(denied?.result?.ok, false)
  assert.equal(f.api.stickers.library().items.length, 0)
  const owner = await send({ text: '请挑一下', sticker: png(11) })
  assert.match(owner.userText, /qq_collect_sticker/)
  const accepted = owner.toolCalls.find((item) => item.name === 'qq_collect_sticker')
  assert.equal(accepted?.result?.ok, true, JSON.stringify(accepted))
  assert.equal(f.api.stickers.library().items.length, 1)
})

test('/save 修改模型后无需下一条消息即可同步新核心会话', async () => {
  const turn = await send({ text: '已有会话' })
  const start = f.fake.modelSelections.length
  const saved = (await f.fake.call('/save', { model: { provider: 'fake', model: 'm-owner' } })).json()
  assert.equal(saved.ok, true)
  await until(() => f.fake.modelSelections.slice(start).some((s) => s.agentId === turn.sessionId && s.model === 'm-owner'), '保存后没有同步已有会话')
  assert.equal(f.fake.turns.length, 1)
})

test('模型同步如实报告失效的新核心会话', async () => {
  const turn = await send({ text: '即将失效的会话' })
  f.fake.agents.delete(turn.sessionId)
  const cfg = f.api.getConfig()
  f.api.setConfig({ ...cfg, model: { ...cfg.model, provider: 'fake', model: 'm-owner' } })
  const result = (await f.fake.call('/models/apply', {})).json()
  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.equal(result.dropped, 1)
  assert.equal(f.api.hub.sessions()[`private:${OWNER}`], undefined)
})

test('配置直接改变人设时，下一轮也要在新会话中运行', async () => {
  const old = await send({ text: '旧会话' })
  const cfg = f.api.getConfig()
  f.api.setConfig({ ...cfg, persona: { ...cfg.persona, current: 'other-persona' } })
  const next = await send({ text: '下一轮' })
  assert.notEqual(next.sessionId, old.sessionId)
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(old.sessionId))
})

test('新核心保存创建时的人设，重启后仍可识别变化并重建', async () => {
  const storeFile = join(f.dir, 'separate-sessions.json')
  const config = structuredClone(f.api.getConfig())
  const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return this } }
  const makeCore = () => createModularCore({
    dsh: f.fake.ctx, onebot: { call: async () => ({ message_id: '1' }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => config, logger: log, log, sessionStoreFile: storeFile,
  })
  const dispatch = (core, id) => core.dispatchLegacyEvent({ ...event({ id }), post_type: 'message', self_id: Number(BOT), time: Math.floor(Date.now() / 1000) })
  let core = makeCore()
  try {
    const n = f.fake.turns.length
    await dispatch(core, ++messageId)
    await until(() => f.fake.turns.length > n, '首轮未创建会话')
    const old = f.fake.turns.at(-1).sessionId
    const saved = JSON.parse(readFileSync(storeFile, 'utf8'))
    assert.equal(saved.chats[`private:${OWNER}`].personaId, config.persona.current)
    await core.dispose()
    config.persona.current = 'another-persona'
    core = makeCore()
    const before = f.fake.turns.length
    await dispatch(core, ++messageId)
    await until(() => f.fake.turns.length > before, '重启后消息未运行')
    assert.notEqual(f.fake.turns.at(-1).sessionId, old)
    assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(old))
  } finally { await core.dispose() }
})

test('/persona/save 只重置正在使用被修改人设的会话', async () => {
  await f.fake.call('/persona/save', { id: 'edit-persona', name: '测试', body: '原来的正文。' })
  await f.fake.call('/save', { persona: { groups: { 777: 'edit-persona' } } })
  const priv = await send({ text: '私聊未指定人设' })
  const group = await send({ group: '777', user: OTHER, text: '群聊指定人设' })
  const saved = (await f.fake.call('/persona/save', { id: 'edit-persona', name: '测试', body: '修改后的正文。' })).json()
  assert.equal(saved.ok, true)
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(group.sessionId))
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(priv.sessionId))
  const next = await send({ group: '777', user: OTHER, text: '修改后' })
  assert.notEqual(next.sessionId, group.sessionId)
  assert.match(next.persona, /修改后的正文/)
})

test('旧映射没有人设元数据时以首次恢复配置为基线', async () => {
  const old = await send({ text: '旧映射' })
  const storeFile = join(f.dir, 'old-sessions.json')
  writeFileSync(storeFile, JSON.stringify({ version: 1, chats: { [`private:${OWNER}`]: { sessionId: old.sessionId, createdAt: Date.now() } } }))
  const config = structuredClone(f.api.getConfig())
  const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return this } }
  const makeCore = () => createModularCore({
    dsh: f.fake.ctx, onebot: { call: async () => ({ message_id: '1' }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => config, logger: log, log, sessionStoreFile: storeFile,
  })
  const dispatch = (core) => core.dispatchLegacyEvent({ ...event({ id: ++messageId }), post_type: 'message', self_id: Number(BOT), time: Math.floor(Date.now() / 1000) })
  let core = makeCore()
  try {
    let before = f.fake.turns.length
    await dispatch(core)
    await until(() => f.fake.turns.length > before, '旧映射恢复后未运行')
    assert.equal(f.fake.turns.at(-1).sessionId, old.sessionId)
    assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(old.sessionId))
    assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).chats[`private:${OWNER}`].personaId, config.persona.current)
    await core.dispose()
    config.persona.current = 'after-baseline'
    core = makeCore()
    before = f.fake.turns.length
    await dispatch(core)
    await until(() => f.fake.turns.length > before, '变更人设后未运行')
    assert.notEqual(f.fake.turns.at(-1).sessionId, old.sessionId)
    assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(old.sessionId))
  } finally { await core.dispose() }
})

test('会话创建中切换人设后不用旧人设会话运行', async () => {
  await f.fake.call('/persona/save', { id: 'inflight-persona', name: '新', body: '创建中切换的新人格。' })
  const ctrl = f.fake.ctx.services.sessionController
  const create = ctrl.create.bind(ctrl)
  let firstId = ''
  let release
  const held = new Promise((resolve) => { release = resolve })
  ctrl.create = async (options) => {
    const created = await create(options)
    if (!firstId) { firstId = created.sessionId; await held }
    return created
  }
  try {
    f.mock.push(event({ text: '创建中', id: ++messageId }))
    await until(() => firstId, '会话创建未开始')
    const saved = (await f.fake.call('/save', { persona: { current: 'inflight-persona' } })).json()
    assert.equal(saved.ok, true)
    release()
    await until(() => f.fake.turns.length, '切换后未运行')
    assert.notEqual(f.fake.turns.at(-1).sessionId, firstId)
    assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(firstId))
    assert.match(f.fake.turns.at(-1).persona, /创建中切换的新人格/)
  } finally { release(); ctrl.create = create }
})

test('K-03B 旧 sessions.json 只留作迁移输入，运行与重置不再回退或写回', async () => {
  const legacy = { chats: { 'group:999': { sessionId: 'legacy-only', createdAt: 1 } } }
  const legacyFile = join(f.dir, 'sessions.json')
  writeFileSync(legacyFile, JSON.stringify(legacy))
  const current = await send({ text: '当前会话' })
  const systemId = f.fake.turns.at(-1).sessionId
  assert.equal(systemId, current.sessionId)
  await f.api.hub.runSystemTurn('k03-check', 'K03 后台', '后台回合')

  assert.equal(f.api.hub.chatOfSession('legacy-only'), '')
  assert.equal(f.api.hub.resetChat('group:999'), false)
  assert.equal(f.api.hub.sessions()['group:999'], undefined)
  assert.ok(!f.api.hub.knownChats().some((chat) => chat.chatId === 'group:999'))
  assert.equal(readFileSync(legacyFile, 'utf8'), JSON.stringify(legacy), '后台回合不得写旧 sessions.json')
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes('legacy-only'))

  assert.equal(f.api.hub.resetSessions(), 2, '只重置当前 QQ 会话与当前系统会话')
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(current.sessionId))
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes('legacy-only'))
  assert.equal(readFileSync(legacyFile, 'utf8'), JSON.stringify(legacy))
})

test('模型同步支持 session.append 回退且跳过未变化模型', async () => {
  const turn = await send({ text: '准备模型同步' })
  const ctrl = f.fake.ctx.services.sessionController
  delete ctrl.agents.selectForNextRequest
  const cfg = f.api.getConfig()
  f.api.setConfig({ ...cfg, model: { ...cfg.model, provider: 'fake', model: 'm-owner' } })
  const first = (await f.fake.call('/models/apply', {})).json()
  assert.equal(first.applied, 1)
  assert.ok(f.fake.agents.get(turn.sessionId).events.some((event) => event.type === 'model/selection' && event.data.model === 'm-owner'))
  const second = (await f.fake.call('/models/apply', {})).json()
  assert.equal(second.applied, 0)
  assert.equal(second.skipped, 1)
})

// —— 真机 2026-11-15：群聊默认锁在「豆包」、私聊默认锁在小鲸鱼时，点「设为当前」切全局卡。
//    旧实现拿 entry.personaId（建会话那一刻的快照）去比已改过的 current：
//      · 群被 groupDefault 钉住 → 预期人设没变，确实不该重置（这条要保住）；
//      · 但私聊被 privateDefault 钉住、用户点「设为当前」时，预期同样没变 ——
//        用户看到的却是「切卡完全没反应」，且回执说「下一轮回复起生效」，属于谎报。
//    新口径：按配置算新旧预期，预期真的变了才重置；没变的如实回报「不受全局切换影响」。
test('/persona/use 与默认人设锁定时：如实回报原因，不谎称已生效', async () => {
  await f.fake.call('/persona/save', { id: 'p-global-a', name: '全局A', body: '你是全局A。' })
  await f.fake.call('/persona/save', { id: 'p-group-x', name: '群X', body: '你是群X。' })
  await f.fake.call('/persona/save', { id: 'p-priv-y', name: '私聊Y', body: '你是私聊Y。' })
  // 全局 = 全局A；群 777 默认锁「群X」；私聊默认锁「私聊Y」
  await f.fake.call('/save', { persona: { current: 'p-global-a', groupDefault: 'p-group-x', privateDefault: 'p-priv-y' } })
  const priv = await send({ text: '私聊先来一句' })
  const group = await send({ group: '777', user: OTHER, text: '群里来一句' })
  assert.match(priv.persona, /私聊Y/)
  assert.match(group.persona, /群X/)

  // 切全局卡：两条聊天的预期人设都没变（被默认值钉住）
  const used = (await f.fake.call('/persona/use', { id: 'p-priv-y' })).json()
  assert.equal(used.ok, true)
  assert.equal(used.reset, 0, '被默认值钉住的会话不该被重置')
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(priv.sessionId))
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(group.sessionId))
  assert.match(used.message, /不受全局切换影响/, '没生效必须如实说，不能谎称「下一轮起生效」')
  assert.match(used.message, /跟随全局人设/)

  // 把群默认松开（改成跟随全局）：预期从「群X」变成新全局 → 必须立刻重置
  const saved = (await f.fake.call('/save', { persona: { groupDefault: '' } })).json()
  assert.equal(saved.ok, true)
  assert.ok(f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(group.sessionId), '改默认人设后该群会话要立即重置')
  assert.ok(!f.fake.ctx.workspaceRegistry.archivedSessionIds.includes(priv.sessionId), '私聊默认没变，不能连带重置')
  const next = await send({ group: '777', user: OTHER, text: '松绑后' })
  assert.notEqual(next.sessionId, group.sessionId)
  assert.match(next.persona, /私聊Y/, '松开群默认后跟随全局，而此时全局就是私聊Y这张卡')
})
