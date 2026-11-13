import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { createSharedOutbox } from '../src/host/shared-outbox.js'
import { createHubEgress } from '../src/host/hub-egress.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let dataDir
let wavFile
let fixtures
let previousDataDir

beforeEach(() => {
  previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'group-deliver-order-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  wavFile = join(dataDir, 'voice.wav')
  writeFileSync(wavFile, Buffer.from('fake wav'))
  fixtures = []
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
  else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
  for (const fixture of fixtures || []) {
    fixture.outbox?.dispose()
    fixture.fake.dispose()
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

function config(overrides = {}) {
  return {
    ownerQQ: '10000001',
    botQQ: '20000002',
    workspaceDir: dataDir,
    enabled: false,
    dryRun: false,
    allow: { private: ['10000001'], groups: ['777'] },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0, autoMaxChars: 300 },
    stickers: { enabled: false, faces: false, autoChance: 0 },
    group: { interjectChance: 0, quota: { enabled: false } },
    reply: { groupMaxChars: 500, maxBubbles: 12 },
    ...overrides,
  }
}

function makeHub(cfg, { tts, egressRef, stickers, hooks } = {}) {
  const fake = createFakeDsh({ brain: () => '' })
  const physicalCalls = []
  const onebot = {
    async call(action, params) {
      physicalCalls.push({ action, params })
      return { message_id: physicalCalls.length }
    },
  }
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: noopLog,
    onebot,
    stickers: stickers || { match: () => null, segmentFor: () => null, pickForReply: () => null },
    tts: tts || { speak: async () => ({ file: wavFile, engine: 'test' }) },
    buildTools: () => [],
    egressRef,
    hooks,
  })
  const fixture = { fake, hub, physicalCalls, outbox: egressRef?.outbox }
  fixtures.push(fixture)
  return fixture
}

function makeSharedHub(cfg, { send, ...options } = {}) {
  const sharedCalls = []
  const outbox = createSharedOutbox({
    onebot: { call: async (action, params) => {
      sharedCalls.push({ action, params })
      return send ? send(action, params) : { message_id: sharedCalls.length }
    } },
    getConfig: () => cfg,
    log: noopLog,
  })
  const fixture = makeHub(cfg, { ...options, egressRef: { current: createHubEgress({ outbox, log: noopLog }), outbox } })
  return { ...fixture, sharedCalls }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('群聊同 chatKey 的富媒体投递按调用顺序进入 Shared Outbox', async () => {
  const ttsGate = deferred()
  const ttsStarted = deferred()
  const cfg = config({
    enabled: true,
    voice: { enabled: true, autoChance: 0, autoMaxChars: 300 },
  })
  const outbox = createSharedOutbox({
    onebot: {
      async call(action, params) {
        physicalCalls.push({ action, params })
        return { message_id: physicalCalls.length }
      },
    },
    getConfig: () => cfg,
    log: noopLog,
  })
  const physicalCalls = []
  const egressRef = { current: createHubEgress({ outbox, log: noopLog }), outbox }
  const { hub } = makeHub(cfg, {
    egressRef,
    tts: {
      async speak() {
        ttsStarted.resolve()
        await ttsGate.promise
        return { file: wavFile, engine: 'test' }
      },
    },
  })

  const first = hub.deliver('group:777', '<voice>先到语音</voice>')
  await ttsStarted.promise
  const second = hub.deliver('group:777', '后到文字')
  await pause(20)
  ttsGate.resolve()
  await Promise.all([first, second])

  assert.deepEqual(
    physicalCalls.map(({ params }) => params.message.map((seg) => seg.type === 'record' ? 'voice' : seg.data?.text).join('')),
    ['voice', '后到文字'],
    '第一轮富媒体在准备期间占住该 chat 的投递次序，之后调用不能超车',
  )
})

test('群聊超过 3 条合并时保留 voice 类型和 replyTo', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', [
    '<reply:7>这句带引用',
    '<voice>这句必须仍是语音</voice>',
    '后续文字一',
    '后续文字二',
  ].join('|||'), { simulate: true, refs: { 7: { mid: '700', uid: '501' } } })

  assert.ok(items.length <= 3, `合并后最多 3 条：${JSON.stringify(items)}`)
  assert.ok(items.some((item) => item.kind === 'voice' && item.value === '这句必须仍是语音'), JSON.stringify(items))
  assert.ok(items.some((item) => item.kind === 'text' && item.replyTo === '7'), JSON.stringify(items))
  assert.ok(items.filter((item) => item.kind === 'text').some((item) => item.value.includes('后续文字一') && item.value.includes('后续文字二')), JSON.stringify(items))
})

test('群聊超过 3 条合并时图片与表情维持先后位置，不被统一移到文字后面', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', [
    '![图](base64://eA==)',
    '图片之后的文字',
    '表情之前的文字',
    '<sticker:吃瓜>',
  ].join('|||'), { simulate: true })

  assert.deepEqual(items.map((item) => item.kind), ['image', 'text', 'sticker'], JSON.stringify(items))
  assert.ok(items[1].value.includes('图片之后的文字'))
  assert.ok(items[1].value.includes('表情之前的文字'))
  assert.equal(items[2].value, '吃瓜')
})

test('群聊超过 3 条合并时，文字前后的表情不跨越内容', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', [
    '表情之前',
    '<sticker:开心>',
    '表情之后一',
    '表情之后二',
  ].join('|||'), { simulate: true })

  assert.deepEqual(items.map((item) => item.kind), ['text', 'sticker', 'text'], JSON.stringify(items))
  assert.equal(items[0].value, '表情之前')
  assert.match(items[2].value, /表情之后一.*表情之后二/s)
})


test('慢语音准备期间，同会话的独立 Shared Outbox 投递不能抢先', async () => {
  const ttsGate = deferred()
  const ttsStarted = deferred()
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const physicalCalls = []
  const outbox = createSharedOutbox({
    onebot: { call: async (action, params) => {
      physicalCalls.push({ action, params })
      return { message_id: physicalCalls.length }
    } },
    getConfig: () => cfg,
    log: noopLog,
  })
  const { hub } = makeHub(cfg, {
    egressRef: { current: createHubEgress({ outbox, log: noopLog }), outbox },
    tts: { speak: async () => { ttsStarted.resolve(); await ttsGate.promise; return { file: wavFile, engine: 'test' } } },
  })

  const first = hub.deliver('group:777', '<voice>先到语音</voice>')
  await ttsStarted.promise
  const second = outbox.request({ chatKey: 'group:777', sourceModuleId: 'core', segments: [{ type: 'text', data: { text: '后到文字' } }] })
  await pause(20)
  ttsGate.resolve()
  await Promise.all([first, second])

  assert.deepEqual(physicalCalls.map(({ params }) => params.message[0].type), ['record', 'text'])
})

test('群聊超 3 条时，被合并的文字保留显式引用', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', '第一句|||第二句|||<reply:7>引用句|||最后一句', { simulate: true })
  assert.ok(items.length <= 3)
  assert.ok(items.some((item) => item.replyTo === '7' && item.value.includes('引用句')), JSON.stringify(items))
})


test('真实群投递：引用、语音、合并文本按顺序经 Shared Outbox 入账', async () => {
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const { hub, outbox, physicalCalls, sharedCalls } = makeSharedHub(cfg)
  await hub.deliver('group:777', '<reply:7>引用句|||<voice>语音内容</voice>|||后文一|||后文二', { refs: { 7: { mid: '700', uid: '501' } } })

  assert.equal(physicalCalls.length, 0, 'hub 不能直达网关')
  assert.equal(sharedCalls.length, 3)
  assert.deepEqual(sharedCalls.map((c) => c.params.message.map((s) => s.type)), [['reply', 'text'], ['record'], ['text']])
  assert.equal(sharedCalls[0].params.message[0].data.id, '700')
  assert.match(sharedCalls[2].params.message[0].data.text, /后文一.*后文二/s)
  assert.equal(outbox.ledger.stats().byState.sent, 3)
})

test('文字与图片、表情交错时，3 条内的物理消息段保持原始顺序', async () => {
  const cfg = config({ enabled: true, stickers: { enabled: true, faces: false, autoChance: 0 } })
  const stickers = {
    match: (name) => ({ name, md5: 'abc' }),
    segmentFor: () => ({ type: 'image', data: { file: 'base64://c3RpY2tlcg==', sub_type: 1 } }),
    pickForReply: () => null,
  }
  const { hub, outbox, physicalCalls, sharedCalls } = makeSharedHub(cfg, { stickers })
  await hub.deliver('group:777', '图前|||![图](base64://aW1n)|||图后|||<sticker:开心>|||表情后')

  assert.equal(physicalCalls.length, 0)
  assert.ok(sharedCalls.length <= 3, `物理消息超过 3 条：${sharedCalls.length}`)
  const ordered = sharedCalls.flatMap((c) => c.params.message).map((s) => s.type === 'text' ? s.data.text : s.type === 'image' && s.data.sub_type === 1 ? '表情' : s.type === 'image' ? '图片' : s.type)
  assert.deepEqual(ordered, ['图前', '图片', '图后', '表情', '表情后'])
  assert.equal(outbox.ledger.stats().byState.sent, sharedCalls.length)
})

test('dryRun：语音和图片均由 Shared Outbox 记 cancelled，不能物理发送', async () => {
  const cfg = config({ enabled: true, dryRun: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const { hub, outbox, sharedCalls, physicalCalls } = makeSharedHub(cfg)
  await hub.deliver('group:777', '<voice>语音内容</voice>|||![图](base64://aW1n)')
  assert.deepEqual(sharedCalls, [])
  assert.deepEqual(physicalCalls, [])
  assert.equal(outbox.ledger.stats().byState.cancelled, 2)
})

test('身份闸：群聊含主人号码的文本不能物理发送', async () => {
  const cfg = config({ enabled: true, security: { identityGuard: { enabled: true, mode: 'block' } } })
  const { hub, sharedCalls, physicalCalls } = makeSharedHub(cfg)
  await hub.deliver('group:777', '主人 QQ 10000001')
  assert.deepEqual(sharedCalls, [])
  assert.deepEqual(physicalCalls, [])
})

test('多个连续 voice 合并时不降级，保留完整语音内容和 3 条上限', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', '<voice>一</voice>|||<voice>二</voice>|||<voice>三</voice>|||<voice>四</voice>', { simulate: true })
  assert.ok(items.length <= 3)
  assert.ok(items.every((item) => item.kind === 'voice'), JSON.stringify(items))
  assert.match(items.map((item) => item.value).join(' '), /一.*二.*三.*四/s)
})


test('多个独立语音交错文字：不超过 3 条、不改变语音类型且文字顺序不能丢', async () => {
  const { hub } = makeHub(config())
  const items = await hub.deliver('group:777', '甲|||<voice>语音一</voice>|||乙|||<voice>语音二</voice>|||丙', { simulate: true })
  assert.ok(items.length <= 3, JSON.stringify(items))
  const parts = items.flatMap((item) => item.kind === 'mixed' ? item.parts : [item])
  assert.equal(parts.filter((item) => item.kind === 'voice').length, 2, JSON.stringify(items))
  assert.match(parts.filter((item) => item.kind === 'text').map((item) => item.value).join(' '), /甲.*乙.*丙/s)
  assert.deepEqual(parts.map(({ kind, value }) => [kind, value]), [
    ['text', '甲'], ['voice', '语音一'], ['text', '乙'], ['voice', '语音二'], ['text', '丙'],
  ])
})

test('超过配置分条数的群回复：解析阶段也不能移动图片或丢掉引用', async () => {
  const cfg = config({ reply: { groupMaxChars: 500, maxBubbles: 6 } })
  const { hub } = makeHub(cfg)
  const items = await hub.deliver('group:777', '甲|||![图](base64://eA==)|||乙|||丙|||丁|||戊|||己|||<reply:7>庚', { simulate: true })
  const parts = items.flatMap((item) => item.kind === 'mixed' ? item.parts : [item])
  const imageIndex = parts.findIndex((item) => item.kind === 'image')
  const before = parts.slice(0, imageIndex).filter((item) => item.kind === 'text').map((item) => item.value).join(' ')
  const after = parts.slice(imageIndex + 1).filter((item) => item.kind === 'text').map((item) => item.value).join(' ')
  assert.equal(before, '甲', JSON.stringify(parts))
  assert.match(after, /乙.*丙.*丁.*戊.*己.*庚/s)
  assert.ok(parts.some((item) => item.replyTo === '7' && item.value.includes('庚')), JSON.stringify(parts))
  assert.ok(items.length <= 3)
})


test('先进入 Shared Outbox 的同群文字会挡住后续语音物理发送', async () => {
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const gate = deferred()
  const started = deferred()
  const { hub, outbox, sharedCalls } = makeSharedHub(cfg, {
    send: async (action, params) => {
      if (params.message[0].type === 'text') { started.resolve(); await gate.promise }
      return { message_id: params.message[0].type === 'text' ? '1' : '2' }
    },
  })
  const first = outbox.request({ chatKey: 'group:777', segments: [{ type: 'text', data: { text: '已入队' } }] })
  await started.promise
  const second = hub.deliver('group:777', '<voice>后续语音</voice>')
  await pause(20)
  assert.equal(sharedCalls.length, 1)
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(sharedCalls.map((c) => c.params.message[0].type), ['text', 'record'])
  assert.equal(outbox.ledger.stats().byState.sent, 2)
})

test('慢语音只阻塞同一聊天，其他聊天可并行投递', async () => {
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const gate = deferred()
  const started = deferred()
  const { hub, sharedCalls } = makeSharedHub(cfg, {
    tts: { speak: async () => { started.resolve(); await gate.promise; return { file: wavFile, engine: 'test' } } },
  })
  const first = hub.deliver('group:777', '<voice>群语音</voice>')
  await started.promise
  const second = hub.deliver('private:10000001', '私聊文字')
  await second
  assert.equal(sharedCalls.length, 1)
  assert.equal(sharedCalls[0].action, 'send_private_msg')
  gate.resolve()
  await first
  assert.equal(sharedCalls[1].action, 'send_group_msg')
})

test('Shared Outbox 复核 send hook 改写的身份泄露并记 cancelled', async () => {
  const cfg = config({ enabled: true, security: { identityGuard: { enabled: true, mode: 'block' } } })
  const { hub, outbox, sharedCalls } = makeSharedHub(cfg, {
    hooks: { send: async () => [{ type: 'text', data: { text: 'QQ 10000001' } }] },
  })
  await hub.deliver('group:777', '安全文本')
  assert.deepEqual(sharedCalls, [])
  assert.equal(outbox.ledger.stats().byState.cancelled, 1)
})

test('Shared Outbox 的语音 unknown 不追加文本或重发，并如实记账', async () => {
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const { hub, outbox, sharedCalls } = makeSharedHub(cfg, {
    send: async () => { const error = new Error('超时'); error.unknown = true; throw error },
  })
  await hub.deliver('group:777', '<voice>语音可能已发送</voice>')
  assert.equal(sharedCalls.length, 1)
  assert.equal(sharedCalls[0].params.message[0].type, 'record')
  assert.equal(outbox.ledger.stats().byState.unknown, 1)
})

test('群配置 maxBubbles 小于 3 时不放宽原有文字上限', async () => {
  const { hub } = makeHub(config({ reply: { groupMaxChars: 500, maxBubbles: 1 } }))
  const items = await hub.deliver('group:777', '第一|||第二|||第三|||第四', { simulate: true })
  assert.equal(items.length, 1)
  assert.match(items[0].value, /第一.*第二.*第三.*第四/s)
})


test('已结束投递的异步回调不能绕开同群后续投递队列', async () => {
  const cfg = config({ enabled: true, voice: { enabled: true, autoChance: 0, autoMaxChars: 300 } })
  const voiceGate = deferred()
  const voiceStarted = deferred()
  const laterGate = deferred()
  const laterStarted = deferred()
  let hub
  let later
  const fixture = makeSharedHub(cfg, {
    tts: { speak: async () => { voiceStarted.resolve(); await voiceGate.promise; return { file: wavFile, engine: 'test' } } },
    hooks: { send: async (message, { note }) => {
      if (note === '种子') laterGate.promise.then(() => { later = hub.deliver('group:777', '晚到文字'); laterStarted.resolve() })
      return message
    } },
  })
  hub = fixture.hub
  await hub.deliver('group:777', '种子')
  const voice = hub.deliver('group:777', '<voice>先到语音</voice>')
  await voiceStarted.promise
  laterGate.resolve()
  await laterStarted.promise
  await pause(20)
  const beforeVoiceReady = fixture.sharedCalls.length
  voiceGate.resolve()
  await Promise.all([voice, later])
  assert.equal(beforeVoiceReady, 1)
  assert.deepEqual(fixture.sharedCalls.map(({ params }) => params.message[0].type), ['text', 'record', 'text'])
})


test('仍在发送的 hook 中启动异步回调时，同群后到回复不能抢先', async () => {
  const cfg = config({ enabled: true })
  const hookGate = deferred()
  const hookStarted = deferred()
  const laterGate = deferred()
  const laterStarted = deferred()
  let hub
  let later
  const fixture = makeSharedHub(cfg, {
    hooks: { send: async (message, { note }) => {
      if (note === '先到文字') {
        laterGate.promise.then(() => { later = hub.deliver('group:777', '后到文字'); laterStarted.resolve() })
        hookStarted.resolve()
        await hookGate.promise
      }
      return message
    } },
  })
  hub = fixture.hub
  const first = hub.deliver('group:777', '先到文字')
  await hookStarted.promise
  laterGate.resolve()
  await laterStarted.promise
  await pause(20)
  hookGate.resolve()
  await Promise.all([first, later])
  assert.deepEqual(fixture.sharedCalls.map(({ params }) => params.message[0].data.text), ['先到文字', '后到文字'])
})


test('群配置 maxBubbles=1 时，解析不能跨图片移动文字或丢掉引用', async () => {
  const { hub } = makeHub(config({ reply: { groupMaxChars: 500, maxBubbles: 1 } }))
  const items = await hub.deliver('group:777', '甲|||![图](base64://eA==)|||<reply:7>乙|||丙|||丁', { simulate: true })
  const parts = items.flatMap((item) => item.kind === 'mixed' ? item.parts : [item])
  const imageIndex = parts.findIndex((item) => item.kind === 'image')
  const before = parts.slice(0, imageIndex).filter((item) => item.kind === 'text').map((item) => item.value).join(' ')
  const after = parts.slice(imageIndex + 1).filter((item) => item.kind === 'text').map((item) => item.value).join(' ')
  assert.equal(before, '甲', JSON.stringify(parts))
  assert.match(after, /乙.*丙.*丁/s)
  assert.ok(parts.some((item) => item.replyTo === '7' && item.value.includes('乙')), JSON.stringify(parts))
  assert.ok(items.filter((item) => item.kind === 'text' || (item.kind === 'mixed' && item.parts.some((part) => part.kind === 'text'))).length <= 1)
})
