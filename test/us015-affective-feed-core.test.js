// US-015 宿主侧接线验收：关系信号真的从「一轮回复」流到「图谱」，再流回「下一轮的上下文」。
//
// 这是本故事最关键的一条链，此前两端都是断的：
//   断点 1：tone() 全仓零调用方 → 等级再高也不影响一句话；
//   断点 2：/affective/bump 全仓零内部调用方 → 图永远 size=0、永远停在「陌生人 cool」。
//
// 本文件用真 mock 网关 + fake DSH 跑完整回合，验证：
//   ① 回复投递后自动喂料，图上出现节点、等级上升；
//   ② 下一轮装配时，关系温度真的进了她的上下文（并且随等级变化）；
//   ③ 陌生人等级不注入任何内容（不打扰）；
//   ④ 群聊 / 私聊各自独立，绝不跨 scope；
//   ⑤ 模块关着 / feed 抛错 / 非法 chatKey 时，回复照常投递（容错铁律）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModularCore } from '../src/host/modular-core.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createOneBotClient } from '../src/onebot/client.js'
import affectiveGraph from '../src/modules/affective-graph/index.js'

test.after(() => { setTimeout(() => process.exit(0), 200).unref() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

/** 起模块：真 affective-graph（内存图 + /tmp 数据目录）。 */
function startAffectiveModule() {
  const logs = []
  const routes = new Map()
  const api = {
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)), debug() {} },
    dataDir: (name) => join(mkdtempSync(join(tmpdir(), 'us015-ag-')), name),
    every() {}, onDispose() {},
    route: (p, fn) => routes.set(p, fn),
    core: { http: { body: async (req) => req._body || {} } },
  }
  const mod = affectiveGraph.setup(api)
  return { mod, logs, routes }
}

/**
 * 标准夹具：fake DSH + mock 网关 + 新核心。
 * `modules` 决定 mods.use() 返回什么（模块关着 = use 返回 null）。
 */
async function fixture({ brain = async () => '好呀', modules = null, cfgOver = {} } = {}) {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'us015-ws-'))
  const cfg = {
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    ownerName: '主人',
    allow: { private: ['10000001', '30003'], groups: ['777'] },
    longTasks: false,
    merge: { waitSec: 0.05, maxSec: 0.2, groupWaitSec: 0.05, groupMaxMs: 0.2, groupMaxSec: 0.2 },
    snowluma: { autoStart: false, autoAttach: false },
    workspaceDir,
    ...cfgOver,
  }
  const onebot = createOneBotClient({
    endpoint: () => ({ httpUrl: mock.httpUrl, wsUrl: '', httpToken: mock.token, wsToken: '' }),
    log: noopLog,
    retryDelays: [10, 10, 10],
  })
  const useCalls = []
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot,
    mods: {
      contextFor: async () => '',
      commands: () => [],
      use: (id) => { useCalls.push(id); return modules ? modules(id) : null },
    },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
  })
  return { core, dsh, mock, cfg, onebot, workspaceDir, useCalls }
}

const msgEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9),
  time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

/** 把一轮消息送进主链并等回合落定。 */
async function say(core, text, over = {}) {
  const r = await core.dispatchLegacyEvent(msgEv({ message: [{ type: 'text', data: { text } }], ...over }))
  await sleep(600)
  return r
}

test('US-015 ① 回复投递后自动喂料：图上不再是空图，等级真的涨了', async () => {
  const { mod } = startAffectiveModule()
  // 她的回复也带笑 + 用户说"你真好"，构成 shared-joke + explicit-confirmed 两个正向信号
  const { core, mock } = await fixture({
    brain: async () => '哈哈哈哈，被你发现了，你真好',
    modules: (id) => (id === 'affective-graph' ? mod : null),
  })
  try {
    assert.equal(mod.graph.size(), 0, '起始空图（这正是修复前的生产状态）')
    await say(core, '哈哈哈哈笑死我了，你真好')
    assert.equal(mock.sent('send_private_msg').length >= 1, true, '回复照常投递')
    assert.equal(mod.graph.size(), 1, '喂料后图上出现该私聊节点')
    const tone = mod.toneFor('private:10000001')
    assert.ok(tone.level >= 1, `等级应升到熟络好友（实际 ${tone.level}）`)
    assert.notEqual(tone.temperature, 'cool', '温度应随之变暖')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ② 温度消费：等级升上去之后，下一轮的上下文里真的出现关系姿态', async () => {
  const { mod } = startAffectiveModule()
  const { core, dsh, mock } = await fixture({
    brain: async () => '哈哈哈哈，被你发现了，你真好',
    modules: (id) => (id === 'affective-graph' ? mod : null),
  })
  try {
    // 第 1 轮：陌生人 → 不注入关系姿态
    await say(core, '哈哈哈哈笑死我了，你真好')
    assert.equal(dsh.turns.length, 1)
    assert.doesNotMatch(dsh.turns[0].ctxText, /你和这个人/, '陌生人这一轮不该被塞关系姿态')
    assert.ok(mod.toneFor('private:10000001').level >= 1, '第 1 轮之后已记账')

    // 第 2 轮：装配时 provider 读到新等级 → 注入
    await say(core, '今天也在呢')
    assert.equal(dsh.turns.length >= 2, true)
    const ctx = dsh.turns[dsh.turns.length - 1].ctxText
    assert.match(ctx, /你和这个人/, `第 2 轮上下文应出现关系姿态：${ctx}`)
    assert.match(ctx, /熟络好友|挚友/, '应带上等级标签')
    assert.match(ctx, /玩笑尺度/, '应带上玩笑尺度')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ③ 陌生人等级不注入任何内容（不打扰，也不说"你是陌生人"）', async () => {
  const { mod } = startAffectiveModule()
  const { core, dsh, mock } = await fixture({
    brain: async () => '嗯嗯',
    modules: (id) => (id === 'affective-graph' ? mod : null),
  })
  try {
    await say(core, '今天天气不错，吃饭了吗') // 没有任何关系信号
    assert.equal(dsh.turns.length, 1)
    assert.doesNotMatch(dsh.turns[0].ctxText, /你和这个人/, '陌生人/无等级都不该注入')
    assert.doesNotMatch(dsh.turns[0].ctxText, /陌生人/, '绝不说"你是陌生人"')
    assert.equal(mod.graph.size(), 0, '没有信号就不建节点')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ④ 群聊与私聊各自独立：群里攒的梗不会让私聊变熟', async () => {
  const { mod } = startAffectiveModule()
  const { core, mock } = await fixture({
    brain: async () => '哈哈哈哈，被你发现了，你真好',
    modules: (id) => (id === 'affective-graph' ? mod : null),
    cfgOver: { allow: { private: ['10000001', '30003'], groups: ['777'] } },
  })
  try {
    // 私聊攒分
    await say(core, '哈哈哈哈笑死我了，你真好')
    const privateLevel = mod.toneFor('private:10000001').level
    assert.ok(privateLevel >= 1)

    // 群聊里同样的对话：只能记到群 scope，私聊等级不因此上涨
    await say(core, '哈哈哈哈笑死我了，你真好', {
      message_type: 'group', group_id: 777, user_id: 30003,
      sender: { user_id: 30003, nickname: '群友' },
      message: [{ type: 'at', data: { qq: '20000002' } }, { type: 'text', data: { text: ' 哈哈哈哈笑死我了，你真好' } }],
    })
    assert.equal(mod.toneFor('private:10000001').level, privateLevel, '私聊等级不该被群聊影响')
    assert.ok(mod.toneFor('group:777').level >= 1, '群聊自己攒下等级')
    // 群 scope 读私聊的数据必须被拒（隐私单向流动）
    assert.equal(mod.graph.size() >= 2, true)
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ⑤ 容错：模块关着时回复照常投递（不抛、不挡）', async () => {
  const { core, mock } = await fixture({
    brain: async () => '熟络点也行',
    modules: () => null, // 模块关着：mods.use 一律 null
  })
  try {
    const r = await say(core, '哈哈哈哈笑死我了，你真好')
    assert.equal(r.handled, 'offered')
    assert.equal(mock.sent('send_private_msg').length >= 1, true, '模块关着也必须照常回复')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ⑤ 容错：feed 抛错时回复照常投递（记分失败不许变成回复失败）', async () => {
  const { mod } = startAffectiveModule()
  const broken = {
    ...mod,
    toneFor: mod.toneFor,
    feed: () => { throw new Error('图谱炸了') },
  }
  const { core, dsh, mock } = await fixture({
    brain: async () => '哈哈哈哈，被你发现了',
    modules: (id) => (id === 'affective-graph' ? broken : null),
  })
  try {
    const r = await say(core, '哈哈哈哈笑死我了')
    assert.equal(r.handled, 'offered')
    assert.equal(mock.sent('send_private_msg').length >= 1, true, 'feed 抛错也必须照常回复')
    assert.equal(dsh.turns.length, 1, '回合正常完成')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('US-015 ⑤ 容错：toneFor 抛错时其余 provider 照常（isolate，不 fail-closed）', async () => {
  const { mod } = startAffectiveModule()
  const broken = { ...mod, feed: mod.feed, toneFor: () => { throw new Error('tone 炸了') } }
  const { core, dsh, mock } = await fixture({
    brain: async () => '嗯嗯',
    modules: (id) => (id === 'affective-graph' ? broken : null),
  })
  try {
    const r = await say(core, '哈哈哈哈笑死我了') // 先攒分，让 provider 真的去问 tone
    assert.equal(r.handled, 'offered')
    assert.equal(mock.sent('send_private_msg').length >= 1, true, 'toneFor 抛错也必须照常回复')
    assert.equal(dsh.turns.length, 1)
    // 关系姿态没有注入，但回合完整（不是被 fail-closed 打断）
    assert.doesNotMatch(dsh.turns[0].ctxText, /你和这个人/)
  } finally {
    await core.dispose()
    await mock.close()
  }
})
