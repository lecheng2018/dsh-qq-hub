// 模块系统 + 联动：自己写的模块、替换 / 关掉内置模块、热重载、安全模式、复制内置模块、开放接口、DSH 联动工具。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

let mock, fake, api, dataDir
const modDir = (id) => join(dataDir, 'modules', id)
const writeMod = (id, code) => { mkdirSync(modDir(id), { recursive: true }); writeFileSync(join(modDir(id), 'index.mjs'), code) }
const echoCode = (pong) => `
export default {
  id: 'echo', name: '回声', version: '1.0.0', api: 1,
  defaults: { greet: '你好' },
  settings: [{ key: 'greet', label: '招呼', type: 'text' }, { key: 'secret', label: '密钥', type: 'password' }],
  setup(api) {
    api.on('message', async (msg) => { if (msg.text === 'ping') { await api.sendText(msg.chatId, '${pong}'); return true } return false })
    api.on('reply', (text) => (text === '在呢' ? '在呢～' : undefined))
    api.command({ name: 'echo', aliases: ['回声'], desc: '回声', run: (arg) => 'echo: ' + arg })
    api.tool(() => api.defineTool({ name: 'echo_tool', description: 'echo', execute: async () => ({ ok: true }) }))
    api.rule(() => '你会说回声')
    api.route('/hi', async () => ({ ok: true, hi: api.settings().greet }))
    api.dshTool({ name: 'echo_dsh', description: '回声', execute: async () => ({ ok: true }) })
    return { shout: (s) => String(s).toUpperCase() }
  },
}`
const sentTo = (id) => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === String(id)).map((c) => c.params.message.map((s) => s.data.text).join(''))
const priv = (t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [{ type: 'text', data: { text: t } }] })
const mod = async (id) => (await fake.call('/modules')).json().list.find((m) => m.id === id)

async function brain({ text }) {
  if (text.includes('联动测试')) return '收到联动'
  if (text.includes('在吗')) return '在呢'
  return '嗯'
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mod-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 }, stickers: { autoChance: 0 },
    merge: { waitSec: 0.2, maxSec: 2 },
    bili: { enabled: true },
    modules: { bili: { enabled: false } },
  }))
  writeMod('echo', echoCode('pong'))
  // 替换内置的空间日记
  writeMod('diary', `export default { id: 'diary', name: '我的日记', api: 1, setup(api) {
    api.route('/diary/history', async () => ({ ok: true, items: [], next: 0, mine: true }))
    return { nextTime: () => 0, history: () => [], writeDiary: async () => { globalThis.__wrote = (globalThis.__wrote || 0) + 1; return { ok: true } } }
  } }`)
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

test('自己写的模块加载了；同名的替换了内置的；关掉的内置模块没在跑', async () => {
  const echo = await mod('echo')
  assert.equal(echo.running, 'user')
  assert.deepEqual(echo.tools, ['echo_tool'])
  assert.deepEqual(echo.commands, ['echo'])
  const diary = await mod('diary')
  assert.equal(diary.running, 'user')
  assert.equal(diary.builtin, true)
  assert.equal(diary.forkedFrom, '1.0.0', '记下了替换时内置模块的版本')
  assert.equal((await mod('bili')).running, null)
  assert.equal((await mod('memory')).running, 'builtin')
  // 被替换的接口走自己写的；关掉模块的接口告诉面板「模块没开」
  assert.equal((await fake.call('/diary/history')).json().mine, true)
  const off = (await fake.call('/bili/state')).json()
  assert.equal(off.ok, false)
  assert.equal(off.moduleOff, true)
  // 自己写的模块的接口在 /ext/模块id/ 下面，设置有默认值
  assert.equal((await fake.call('/ext/echo/hi')).json().hi, '你好')
})

test('模块接管消息、改写回复、加命令；她的规则里有模块补的话，没有关掉模块的本事', async () => {
  mock.push(priv('ping'))
  await until(() => sentTo(OWNER).includes('pong'))
  const turns = fake.turns.length
  await sleep(500)
  assert.equal(fake.turns.length, turns, '被模块接管的消息不交给她')

  mock.push(priv('在吗'))
  await until(() => sentTo(OWNER).includes('在呢～'))

  mock.push(priv('/回声 你好'))
  await until(() => sentTo(OWNER).includes('echo: 你好'))
  mock.push(priv('/help'))
  await until(() => sentTo(OWNER).some((t) => t.includes('扩展模块加的') && t.includes('/echo')))
  mock.push(priv('/diary'))
  await until(() => globalThis.__wrote === 1)

  const rules = fake.variables.get('aurabot_rules_private')()
  assert.match(rules, /你会说回声/)
  assert.doesNotMatch(rules, /你会刷 B 站/, 'B 站模块关着就不说她会刷 B 站')
  // 主人私聊会话：有模块的工具，没有关掉模块的工具
  const agent = [...fake.agents.values()].find((a) => a.preset === 'aurabot-private')
  assert.ok(agent.tools.has('echo_tool'))
  assert.ok(!agent.tools.has('bili_watch'))
  assert.ok(agent.tools.has('remember'))
})

test('面板里关掉内置模块：马上停，它的工具和接口都没了；再打开又回来', async () => {
  await fake.call('/save', { modules: { stickers: { enabled: false } } })
  assert.equal((await mod('stickers')).running, null)
  assert.equal((await fake.call('/stickers')).json().moduleOff, true)
  await fake.call('/save', { modules: { stickers: { enabled: true } } })
  assert.equal((await mod('stickers')).running, 'builtin')
  assert.equal((await fake.call('/stickers')).json().ok, true)
})

test('改了模块文件：几秒内自动重新加载', async () => {
  await sleep(50)
  writeMod('echo', echoCode('pong2'))
  await until(async () => (await mod('echo')).startedAt > 0 && (mock.push(priv('ping')), await sleep(600), sentTo(OWNER).includes('pong2')), 15000)
})

test('替换版写坏了：先用回内置的，面板看得到报错', async () => {
  writeMod('mood', 'export default { id: "mood", setup( {')
  const m = await until(async () => { const x = await mod('mood'); return x.error ? x : null }, 15000)
  assert.equal(m.running, 'builtin')
  assert.equal(m.fallback, true)
  assert.ok(api.mood.label(), '内置的心情照常能用')
})

test('安全模式：自己写的一个都不加载，内置的回来', async () => {
  await fake.call('/save', { safeMode: true })
  assert.equal((await mod('echo')).running, null)
  assert.equal((await mod('diary')).running, 'builtin')
  await fake.call('/save', { safeMode: false })
  assert.equal((await mod('echo')).running, 'user')
  assert.equal((await mod('diary')).running, 'user')
})

test('复制内置模块来改：复制出来的能直接跑（连翻唱这种带数据文件的）', async () => {
  for (const id of ['speakup', 'song']) {
    const r = (await fake.call('/modules/fork', { id })).json()
    assert.equal(r.ok, true, r.message)
    const code = readdirSync(modDir(id)).map((f) => readFileSync(join(modDir(id), f), 'utf8')).join('\n')
    assert.match(code, /globalThis\.aurabot\.lib/)
    assert.doesNotMatch(code, /from '\.\.\//, '没有指回插件目录的相对路径')
    assert.equal((await mod(id)).running, 'user', (await mod(id)).error)
  }
  assert.ok(existsSync(join(modDir('song'), 'studio.js')))
  assert.match(readFileSync(join(modDir('song'), 'studio.js'), 'utf8'), /new URL\('song\/fetch_file\.py', globalThis\.aurabot\.src\)/)
  assert.equal((await fake.call('/song/status')).json().ok, true)
  // 说明文档放进了 modules/
  assert.match(readFileSync(join(dataDir, 'modules', 'API.md'), 'utf8'), /api\.on\('message'/)
})

test('新建模块：从模板建，能直接跑', async () => {
  const r = (await fake.call('/modules/create', { id: 'my-ext', name: '我的扩展' })).json()
  assert.equal(r.ok, true, r.message)
  assert.match(r.prompt, /API\.md/)
  const m = await mod('my-ext')
  assert.equal(m.running, 'user', m.error)
  assert.deepEqual(m.tools, ['my_ext_keywords'])
  assert.equal((await fake.call('/modules/create', { id: 'Bad Id' })).json().ok, false)
})

test('模块设置里的密码不回传给面板', async () => {
  await fake.call('/save', { ext: { echo: { secret: 'abc123', greet: '嗨' } } })
  const cfg = (await fake.call('/state')).json().config
  assert.equal(cfg.ext.echo.secret, '')
  assert.equal(cfg.ext.echo.secretSet, true)
  assert.equal(cfg.ext.echo.greet, '嗨')
  await fake.call('/save', { ext: { echo: { secret: '', greet: '嗨' } } })
  assert.equal(api.getConfig().ext.echo.secret, 'abc123', '面板传回空串 = 不改')
})

test('联动：开放接口要密钥，只能发给白名单，能调模块', async () => {
  assert.equal((await fake.call('/open/info')).json().ok, false)
  await fake.call('/save', { bridge: { http: true } })
  const token = (await fake.call('/bridge/token')).json().token
  assert.match(token, /^ab_/)
  const h = { authorization: 'Bearer ' + token }
  assert.equal((await fake.call('/open/info', null, { authorization: 'Bearer wrong' })).json().ok, false)
  const info = (await fake.call('/open/info', null, h)).json()
  assert.equal(info.ok, true)
  assert.ok(info.modules.some((m) => m.id === 'echo'))
  assert.equal((await fake.call('/open/send', { target: 'private:123', text: 'x' }, h)).json().ok, false)
  const r = (await fake.call('/open/send', { text: '联动发的' }, h)).json()
  assert.equal(r.ok, true)
  await until(() => sentTo(OWNER).includes('联动发的'))
  assert.equal((await fake.call('/open/call', { module: 'echo', method: 'shout', args: ['hi'] }, h)).json().result, 'HI')
  assert.equal((await fake.call('/open/call', { module: 'nope', method: 'x' }, h)).json().ok, false)
  const ev = (await fake.call('/open/events', null, h)).json()
  assert.ok(ev.list.some((e) => e.type === 'message'))
  // 面板拿不到密钥原文，密钥也不能从面板改
  assert.equal((await fake.call('/state')).json().config.bridge.token, '')
  await fake.call('/save', { bridge: { token: 'hack' } })
  assert.equal(api.getConfig().bridge.token, token)
})

test('联动：别的 DSH 插件能 ctx.get(aurabot)；打开后 DSH 会话有全局工具，她自己的 QQ 会话屏蔽掉', async () => {
  const svc = fake.ctx.get('aurabot')
  assert.ok(svc && typeof svc.send === 'function')
  assert.equal(svc.use('echo').shout('a'), 'A')
  assert.equal(fake.ctx.globalTools.size, 0, '默认不挂全局工具')
  await fake.call('/save', { bridge: { dshTools: true } })
  assert.ok(fake.ctx.globalTools.has('aurabot_qq_send'))
  assert.ok(fake.ctx.globalTools.has('echo_dsh'), '模块加的联动工具也挂上了')
  const r = await fake.ctx.globalTools.get('aurabot_qq_send').execute({ text: '从 DSH 发的' })
  assert.equal(r.ok, true)
  await until(() => sentTo(OWNER).includes('从 DSH 发的'))
  // 她的 QQ 会话下一轮重挂工具时屏蔽联动工具
  mock.push(priv('在吗'))
  const agent = [...fake.agents.values()].find((a) => a.preset === 'aurabot-private')
  await until(() => agent.denied.has('aurabot_qq_send'))
  await fake.call('/save', { bridge: { dshTools: false } })
  assert.equal(fake.ctx.globalTools.size, 0)
})
