// T4.4：工程化卫生（身份判定、容器探测、人格卡缓存、常驻 Map 回收、媒体字节上限）。
//
// 报障口径（都是「跑久了才出事」那一类）：
//   · `ownerQQ` 没填时是空串，而系统事件/适配器给的 userId 也可能是空串，
//     `'' === ''` 会被判成主人 → 没配主人的部署里空 userId 会话直接拿 full 档。
//   · cgroup v2 在容器里常常只有一行 `0::/`，旧实现把「读到 cgroup 但没容器标记」
//     判成「不在容器」，Docker 里的实例于是当成宿主机跑。
//   · 人格卡指纹按 mtime+size 缓存，写盘后不失效 → 同一毫秒、同样长度的改动拿到旧指纹。
//   · 常驻进程里 chatId / groupId 只会越来越多，几张 Map 没有上限 = 稳定泄漏。
//   · 合成/生图接口回一坨大文件，`arrayBuffer()` 全量读 → 进程被撑爆。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isOwner, checkAllowed, levelFor, profileToolVisible } from '../src/chat/access.js'
import { cgroupVerdict, EnvironmentDetector } from '../src/runtime/environment-detector.js'
import { createGroupState } from '../src/chat/group-state.js'
import { createInteractionState } from '../src/chat/interaction-state.js'
import { createGroupRoles } from '../src/chat/group-roles.js'
import { createActivityState } from '../src/chat/activity-state.js'
import { createQuotedMessages } from '../src/chat/quoted-messages.js'
import { httpSynth } from '../src/voice/tts.js'
import { createImageGen } from '../src/features/imagegen.js'

// ---------------- 身份判定 ----------------

test('isOwner：空串不算主人（没填 ownerQQ 的部署不许把空 userId 判成主人）', () => {
  assert.equal(isOwner({ ownerQQ: '' }, ''), false)
  assert.equal(isOwner({}, ''), false)
  assert.equal(isOwner({ ownerQQ: '' }, '10001'), false, '主人没配，谁都不是主人')
  assert.equal(isOwner({ ownerQQ: '10001' }, ''), false)
  assert.equal(isOwner({ ownerQQ: '10001' }, '10001'), true)
  assert.equal(isOwner({ ownerQQ: 10001 }, '10001'), true, '配置里存成数字也要认')
})

test('checkAllowed / levelFor / profileToolVisible 与 isOwner 同口径', () => {
  const cfg = { ownerQQ: '', ownerLevel: 'full', allow: { private: ['20002'], groups: ['30003'] }, profilePerms: {} }
  assert.deepEqual(checkAllowed(cfg, { kind: 'private', userId: '' }), { allowed: false, reason: '不在私聊白名单' })
  assert.equal(levelFor(cfg, { kind: 'private', userId: '' }), 'social', '空 userId 拿不到主人档')
  assert.equal(profileToolVisible(cfg, 'qqAvatar', { kind: 'private', userId: '' }), false, '空 userId 不该挂改资料工具')
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: '20002' }).allowed, true)
  assert.equal(profileToolVisible(cfg, 'qqAvatar', { kind: 'private', userId: '20002' }), false, '白名单不等于主人')
})

// ---------------- 容器探测 ----------------

test('cgroupVerdict：v2 裸 `0::/` 是「无结论」，不能当成宿主机', () => {
  assert.equal(cgroupVerdict('0::/'), null)
  assert.equal(cgroupVerdict('0::/docker/0123abcd'), true)
  assert.equal(cgroupVerdict('12:cpu:/docker/0123abcd\n11:memory:/docker/0123abcd'), true)
  assert.equal(cgroupVerdict('0::/system.slice/cron.service'), false)
  assert.equal(cgroupVerdict(''), null)
  assert.equal(cgroupVerdict(undefined), null)
})

test('EnvironmentDetector：读不到结论的 cgroup 要让 isDocker() 返回 null（不是 false）', () => {
  const make = (cgroup) => new EnvironmentDetector({
    platform: 'linux',
    env: {},
    existsSync: () => false,
    readFileSync: () => cgroup,
    freemem: () => 1,
  })
  assert.equal(make('0::/').isDocker(), null, 'cgroup v2 裸根：未知，不能判成宿主机')
  assert.equal(make('0::/docker/abc').isDocker(), true)
  assert.equal(make('0::/init.scope').isDocker(), false)
})

// ---------------- 人格卡 ----------------

test('savePersona 会让指纹缓存失效：同 mtime、同长度也能拿到新正文指纹', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-persona-'))
  const saved = { dsh: process.env.DSH_QQ_HUB_DATA_DIR, aur: process.env.AURABOT_DATA_DIR }
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  try {
    const { savePersona, personaHash } = await import('../src/persona/personas.js')
    savePersona('cache-case', { name: '缓存', tags: ['测试'], body: 'AAAAA' })
    const first = personaHash('cache-case')
    const stat = statSync(join(dir, 'personas', 'cache-case.md'))
    savePersona('cache-case', { name: '缓存', tags: ['测试'], body: 'BBBBB' }) // 同长度
    // 把 mtime 拨回去，制造「mtime + size 都没变」的地址键
    utimesSync(join(dir, 'personas', 'cache-case.md'), stat.atime, stat.mtime)
    const second = personaHash('cache-case')
    assert.notEqual(first, '')
    assert.notEqual(second, first, '写盘后必须失效缓存，否则守卫会以为「卡没改」')
  } finally {
    if (saved.dsh === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = saved.dsh
    if (saved.aur === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = saved.aur
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人格卡的 name/tags 写入前洗掉会切断 YAML 头的字符', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-persona-'))
  const saved = { dsh: process.env.DSH_QQ_HUB_DATA_DIR, aur: process.env.AURABOT_DATA_DIR }
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  try {
    const { savePersona, readPersona, listPersonas } = await import('../src/persona/personas.js')
    savePersona('dirty-head', { name: '甲\r\n乙', tags: ['a]b', 'c\nd'], body: '正文' })
    const card = readPersona('dirty-head')
    assert.equal(card.name, '甲 乙', '\r\n 要压成空格，否则 name 行提前结束')
    assert.deepEqual(card.tags, ['a b', 'c d'], 'tags 里的 ] 和换行会把 tags 数组切断')
    assert.equal(card.body, '正文')

    // 目录里被手工塞进非法 id 的文件不该出现在列表里（点开就报错）
    writeFileSync(join(dir, 'personas', 'bad id.md'), '---\nname: x\ntags: []\n---\n\n正文\n', 'utf8')
    const ids = listPersonas().map((p) => p.id)
    assert.ok(ids.includes('dirty-head'))
    assert.ok(!ids.includes('bad id'), '带空格的 id 读回来写不回去，不该列出来')
    assert.ok(readdirSync(join(dir, 'personas')).includes('bad id.md'))
  } finally {
    if (saved.dsh === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = saved.dsh
    if (saved.aur === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = saved.aur
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------- 常驻 Map 回收 ----------------

test('group-state：落盘前清掉过期 engaged（不然每个进过话题的群永久留一条）', () => {
  const writes = []
  const state = createGroupState({ storage: { read: () => null, write: (snapshot) => writes.push(snapshot) } })
  state.joinTopic('group:1', Date.now() - 10 * 60_000, 60_000) // 十分钟前入场，一分钟窗口 → 已过期
  state.joinTopic('group:2', Date.now(), 60_000)
  assert.equal(state.engagedUntil('group:1') > 0, true, '内存里本来有这条')

  state.dispose() // 落盘一次

  const saved = writes.at(-1)
  assert.deepEqual(Object.keys(saved.engaged), ['group:2'], '过期条目不许进快照')
  assert.equal(state.engagedUntil('group:1'), 0, '顺手从内存里清掉')
})

test('interaction-state：聊天数超过上限时按 LRU 淘汰最久没动过的', () => {
  const state = createInteractionState()
  for (let i = 0; i < 520; i++) state.rememberFaces(`group:${i}`, ['doge'])
  const size = state.size()
  assert.ok(size.faces <= 500, `小黄脸池要有上限，实际 ${size.faces}`)
  assert.equal(state.facesUsed('group:519').has('doge'), true, '最近用过的要留着')
  assert.equal(state.facesUsed('group:0').size, 0, '最久没动过的被淘汰')
})

test('group-roles：查过的群超过上限时淘汰最旧的，最近的仍然命中缓存', async () => {
  const roles = createGroupRoles({
    onebot: { call: async () => ({ role: 'member' }) },
    getConfig: () => ({ botQQ: '1' }),
  })
  for (let i = 0; i < 520; i++) await roles.get(String(i))
  assert.equal(roles.peek('519'), 'member', '最近查过的还在缓存里')
  assert.equal(roles.peek('0'), '', '最旧的那条已被淘汰（不再命中缓存）')
})

test('activity-state.dispose：把所有「正在输入」计时器停掉', () => {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const cleared = []
  globalThis.setInterval = (...args) => { const t = realSet(...args); t.__fake = true; return t }
  globalThis.clearInterval = (t) => { cleared.push(t); return realClear(t) }
  try {
    const state = createActivityState()
    const cfg = { enabled: true, dryRun: false }
    state.startTyping('private:1', { kind: 'private', userId: '1' }, cfg, () => {})
    state.startTyping('private:2', { kind: 'private', userId: '2' }, cfg, () => {})
    assert.equal(state.size().typing, 2)
    state.dispose()
    assert.equal(state.size().typing, 0, 'dispose 之后不许还挂着计时器')
    assert.equal(cleared.length, 2, '每个计时器都要 clearInterval，否则每 15 秒继续骚扰对方')
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

// ---------------- 引用消息 ----------------

test('quoted-messages：拉失败的结果不进缓存（否则这条引用永久「拉不到」）', async () => {
  let calls = 0
  const messages = createQuotedMessages({
    onebot: {
      call: async () => {
        calls += 1
        if (calls === 1) throw new Error('onebot 超时')
        return { sender: { user_id: '50005', nickname: '甲' }, message: [{ type: 'text', data: { text: '被引用的原话' } }] }
      },
    },
    getConfig: () => ({ botQQ: '' }),
  })
  const first = await messages.get('9001', 'group:123')
  assert.equal(first.ok, false, '第一次拉不到')
  const second = await messages.get('9001', 'group:123')
  assert.equal(second.ok, true, '失败不该被缓存：第二次必须真的再试一次')
  assert.equal(calls, 2)
  assert.equal(second.text, '被引用的原话')
})

test('quoted-messages：botQQ 没配时，空 user_id 不许判成「机器人自己发的」', async () => {
  const messages = createQuotedMessages({
    onebot: { call: async () => ({ sender: { user_id: '' }, message: [{ type: 'text', data: { text: '空 id' } }] }) },
    getConfig: () => ({ botQQ: '' }),
  })
  const out = await messages.get('1', 'group:9')
  assert.equal(out.ok, true)
  assert.equal(out.isBot, false, '空串 === 空串 不能说明这是她的消息')
})

// ---------------- 媒体字节上限 ----------------

/**
 * 造一个总字节数超过 30MB 的响应（内容类型可控）。
 *
 * 这里手写 ReadableStream 而不用 `Readable.toWeb(Readable.from(...))`：超限时生产代码会
 * `reader.cancel()`，而 toWeb 适配器在「消费方取消」与「自己的泵」之间会对控制器二次
 * close，Node 22 上会抛 `ERR_INVALID_STATE: Controller is already closed` 的
 * uncaughtException —— 测试本身全 pass，但整个文件被判失败（CI compatibility job 就是
 * 这么红的）。取消是正常路径，这里按规范把它当成幂等的 no-op。
 */
function oversizedResponse(contentType) {
  const chunk = new Uint8Array(4 * 1024 * 1024)
  const total = 9 // 9 × 4MB = 36MB，超过 30MB 上限
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(chunk.slice())
    },
    cancel() {},
  })
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } })
}

test('httpSynth：TTS 响应超过 30MB 立即中止，不把整坨读进内存', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => oversizedResponse('audio/wav')
  try {
    await assert.rejects(() => httpSynth('你好', { urlTemplate: 'https://tts.local/say?text={text}' }), /太大/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('imagegen：自定义接口直接回图片字节时同样受 30MB 限制', async () => {
  const gen = createImageGen({
    getConfig: () => ({
      imageGen: { enabled: true, provider: 'custom', size: '1024x1024', custom: { url: 'https://img.local/draw', method: 'GET' } },
    }),
    log: { info() {}, warn() {}, debug() {} },
    fetchImpl: async () => oversizedResponse('image/png'),
  })
  await assert.rejects(() => gen.generate('一只猫'), /太大/)
})

test('字节上限对「声明长度就超了」的响应立刻拒绝（连读都不读）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('tiny', {
    status: 200,
    headers: { 'content-type': 'audio/wav', 'content-length': String(64 * 1024 * 1024) },
  })
  try {
    await assert.rejects(() => httpSynth('你好', { urlTemplate: 'https://tts.local/say?text={text}' }), /音频太大/)
  } finally {
    globalThis.fetch = realFetch
  }
})
