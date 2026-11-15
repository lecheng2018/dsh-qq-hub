// 模块市场契约测试（PLAN §8 A3 清单）：zip 安全矩阵、sha256、原子落位、checkDef 前置、
// confirmReplace、revoked/delisted、多源 failover + TTL、ID 白名单、并发串行、不自动更新。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

let root, createMarket, readZip, compareVersions, validEntry, userDir, SOURCE_FILE
// zip 构造器（语义同上游 mods makeZip，MIT 注明出处）
const zip = (files, { method = 8, flags = 0, corruptCrc = false } = {}) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const path = Buffer.from(name)
    const body = method === 8 ? deflateRawSync(data) : data
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800 | flags, 6)
    head.writeUInt16LE(method, 8)
    head.writeUInt32LE(corruptCrc ? (crc32(data) ^ 0xff) >>> 0 : crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const n = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(n, 8)
  end.writeUInt16LE(n, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
// 合法模块包：checkDef 要 setup + id 一致
const modSrc = (id) => `export default { id: '${id}', name: '${id}', version: '1.0.0', setup(api) {} }`
const pack = (id, version, extra = {}) => {
  const buf = zip({ 'module.json': JSON.stringify({ id, version }), 'index.mjs': modSrc(id), ...extra })
  return { buf, entry: { id, name: id, version, api: 1, minPluginVersion: '1.0.0', requires: [], capabilities: [], path: `${id}/${id}.zip`, sha256: createHash('sha256').update(buf).digest('hex') } }
}
function setup(packs, { cfg = {}, revoked = [], status = [], fetcher: customFetcher, builtinDir, indexUrls } = {}) {
  let config = { modules: { market: { enabled: true, ...(indexUrls ? { indexUrls } : {}) } }, ...cfg }
  const fetcher = customFetcher || (async (url) => {
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: packs.map((p) => p.entry), revoked }) }
    const p = packs.find((x) => url.endsWith(x.entry.path))
    if (!p) return { ok: false, status: 404 }
    return { ok: true, arrayBuffer: async () => p.buf }
  })
  const mods = { status: () => status, sync: async () => {} }
  const log = { info() {}, warn() {}, debug() {} }
  const m = createMarket({ mods, getConfig: () => config, setConfig: (n) => { config = n }, log, version: '1.4.3', fetcher, retryMs: 1, builtinDir, validateUrl: async () => {} })
  return { m, cfg: () => config }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'qqhub-market-'))
  process.env.AURABOT_DATA_DIR = root
  ;({ createMarket, readZip, compareVersions, validEntry, SOURCE_FILE } = await import('../src/core/market.js'))
  ;({ userDir } = await import('../src/core/modules.js'))
  mkdirSync(userDir(), { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

// ---------------- zip 安全矩阵（R1） ----------------

test('readZip：合法包（deflate + store）解出原文', () => {
  const files = readZip(zip({ 'a.txt': '你好', 'dir/b.txt': 'world' }))
  assert.equal(files.get('a.txt').toString(), '你好')
  assert.equal(files.get('dir/b.txt').toString(), 'world')
  const stored = readZip(zip({ 's.txt': 'store' }, { method: 0 }))
  assert.equal(stored.get('s.txt').toString(), 'store')
})

test('readZip：恶意矩阵全拒 —— zip-slip / 加密 / 坏 CRC / 不支持的压缩方式 / 坏头', () => {
  assert.throws(() => readZip(zip({ '../evil.txt': 'x' })), /不安全的路径/)
  assert.throws(() => readZip(zip({ 'a/../../evil.txt': 'x' })), /不安全的路径/)
  assert.throws(() => readZip(zip({ '/abs.txt': 'x' })), /不安全的路径/)
  assert.throws(() => readZip(zip({ 'C:\\win.txt': 'x' })), /不安全的路径/)
  assert.throws(() => readZip(zip({ 'ok.txt': 'x' }, { flags: 1 })), /加密/)
  assert.throws(() => readZip(zip({ 'ok.txt': 'x' }, { corruptCrc: true })), /校验失败/)
  assert.throws(() => readZip(zip({ 'ok.txt': 'x' }, { method: 12 })), /压缩方式/)
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /不是有效的 zip/)
})

// ---------------- 条目校验（R10） ----------------

test('validEntry：缺关键字段拒条目；compareVersions 只比 x.y.z', () => {
  const good = pack('good-mod', '1.0.0').entry
  assert.equal(validEntry(good), true)
  assert.equal(validEntry({ ...good, id: '../evil' }), false)
  assert.equal(validEntry({ ...good, sha256: 'xyz' }), false)
  assert.equal(validEntry({ ...good, version: 'abc' }), false)
  assert.equal(validEntry({ ...good, path: '' }), false)
  assert.equal(validEntry(null), false)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
})

// ---------------- 安装 ----------------

test('安装：落位 + SOURCE_FILE + config 记账；更新不自动发生', async () => {
  const p = pack('install-mod', '1.0.0')
  const { m, cfg } = setup([p])
  const r = await m.install('install-mod')
  assert.equal(r.ok, true, r.message)
  assert.equal(existsSync(join(userDir(), 'install-mod', 'index.mjs')), true)
  const src = JSON.parse(readFileSync(join(userDir(), 'install-mod', SOURCE_FILE), 'utf8'))
  assert.equal(src.version, '1.0.0')
  assert.equal(src.sha256, p.entry.sha256)
  assert.equal(cfg().modules.market.installed['install-mod'].version, '1.0.0')
  assert.equal(existsSync(join(userDir(), '.install-mod.installing')), false, '暂存清干净')
  // 索引出了新版：list 标 update，但不自动装
  const p2 = pack('install-mod', '2.0.0')
  const t = setup([p2], { status: [{ id: 'install-mod', name: 'install-mod', description: '' }] })
  const list = await t.m.list()
  const e = list.list.find((x) => x.id === 'install-mod')
  assert.equal(e.update, true)
  assert.equal(e.installed, '1.0.0', '没自动更新')
})

test('安装：sha256 不符整包拒绝，不落位', async () => {
  const p = pack('sha-mod', '1.0.0')
  p.entry.sha256 = 'f'.repeat(64)
  const { m } = setup([p])
  const r = await m.install('sha-mod')
  assert.equal(r.ok, false)
  assert.match(r.message, /校验不通过/)
  assert.equal(existsSync(join(userDir(), 'sha-mod')), false)
})

test('安装：checkDef 不过的包不落位（R3 前置校验）', async () => {
  const buf = zip({ 'module.json': JSON.stringify({ id: 'bad-mod', version: '1.0.0' }), 'index.mjs': 'export default { id: \'bad-mod\' }' })
  const entry = { id: 'bad-mod', name: 'bad', version: '1.0.0', api: 1, path: 'bad-mod/bad-mod.zip', sha256: createHash('sha256').update(buf).digest('hex') }
  const { m } = setup([{ buf, entry }])
  const r = await m.install('bad-mod')
  assert.equal(r.ok, false)
  assert.match(r.message, /校验不过/)
  assert.equal(existsSync(join(userDir(), 'bad-mod')), false)
  assert.equal(existsSync(join(userDir(), '.bad-mod.installing')), false, '失败清暂存')
})

test('安装：manifest 和索引对不上拒绝；没有入口拒绝', async () => {
  const buf = zip({ 'module.json': JSON.stringify({ id: 'other-id', version: '1.0.0' }), 'index.mjs': modSrc('other-id') })
  const entry = { id: 'mismatch-mod', name: 'x', version: '1.0.0', api: 1, path: 'm/m.zip', sha256: createHash('sha256').update(buf).digest('hex') }
  const r = await setup([{ buf, entry }]).m.install('mismatch-mod')
  assert.equal(r.ok, false)
  assert.match(r.message, /对不上/)
  const buf2 = zip({ 'module.json': JSON.stringify({ id: 'noentry-mod', version: '1.0.0' }) })
  const entry2 = { id: 'noentry-mod', name: 'x', version: '1.0.0', api: 1, path: 'n/n.zip', sha256: createHash('sha256').update(buf2).digest('hex') }
  const r2 = await setup([{ buf: buf2, entry: entry2 }]).m.install('noentry-mod')
  assert.equal(r2.ok, false)
  assert.match(r2.message, /入口/)
})

test('安装：id 白名单防穿越（R2）；自己的同名文件夹不覆盖', async () => {
  const { m } = setup([])
  for (const id of ['../evil', 'a/b', 'UPPER', 'x'.repeat(50), '']) {
    const r = await m.install(id)
    assert.equal(r.ok, false, id)
  }
  mkdirSync(join(userDir(), 'my-own'), { recursive: true })
  writeFileSync(join(userDir(), 'my-own', 'index.mjs'), modSrc('my-own'))
  const p = pack('my-own', '1.0.0')
  const r = await setup([p]).m.install('my-own')
  assert.equal(r.ok, false)
  assert.match(r.message, /你自己的文件夹/)
})

test('安装：replacesBuiltin 要 confirmReplace（R4，按真实文件判断）', async () => {
  const builtinDir = join(root, 'builtins')
  mkdirSync(join(builtinDir, 'builtin-mod'), { recursive: true })
  const p = pack('builtin-mod', '1.0.0')
  const { m } = setup([p], { builtinDir })
  const r = await m.install('builtin-mod')
  assert.equal(r.ok, false)
  assert.equal(r.needConfirm, true)
  const r2 = await m.install('builtin-mod', { confirmReplace: true })
  assert.equal(r2.ok, true, r2.message)
})

test('安装：revoked 拦截带原因；api/版本门槛；requires 缺依赖', async () => {
  const p = pack('revoked-mod', '1.0.0')
  const { m } = setup([p], { revoked: [{ id: 'revoked-mod', versions: ['1.0.0'], reason: '有安全漏洞' }] })
  const r = await m.install('revoked-mod')
  assert.equal(r.ok, false)
  assert.match(r.message, /已撤回：有安全漏洞/)
  const hi = pack('hi-api', '1.0.0'); hi.entry.api = 99
  assert.match((await setup([hi]).m.install('hi-api')).message, /扩展接口 v99/)
  const dep = pack('need-dep', '1.0.0'); dep.entry.requires = ['not-installed']
  assert.match((await setup([dep]).m.install('need-dep')).message, /要先装/)
})

test('安装：默认 OFF 门控；并发串行化（exclusive）', async () => {
  const p = pack('gate-mod', '1.0.0')
  const off = setup([p], { cfg: { modules: { market: { enabled: false } } } })
  assert.match((await off.m.install('gate-mod')).message, /没启用/)
  assert.equal((await off.m.list()).disabled, true)
  // 并发：第二个立刻被拒
  let release
  const slowFetcher = async (url) => {
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: [p.entry] }) }
    await new Promise((done) => { release = done })
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const { m } = setup([p], { fetcher: slowFetcher })
  const first = m.install('gate-mod')
  await new Promise((done) => setTimeout(done, 20))
  const second = await m.install('gate-mod')
  assert.equal(second.ok, false)
  assert.match(second.message, /还没做完/)
  release()
  assert.equal((await first).ok, true)
})

// ---------------- 索引多源 failover + TTL（M4） ----------------

test('索引：第一源挂了换第二源；全挂报错但不影响已装；TTL 缓存', async () => {
  const p = pack('failover-mod', '1.0.0')
  const hits = []
  const fetcher = async (url) => {
    hits.push(url)
    if (url.includes('bad-source')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: [p.entry] }) }
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const { m } = setup([p], { fetcher, indexUrls: ['https://bad-source/index.json', 'https://good-source/index.json'] })
  const list = await m.list()
  assert.equal(list.ok, true)
  assert.equal(list.source, 'https://good-source/index.json')
  assert.equal(hits.filter((u) => u.includes('bad-source')).length, 2, '瞬断重试一次再换源')
  // TTL：第二次 list 不再打索引
  const before = hits.length
  await m.list()
  assert.equal(hits.length, before)
  // 全挂：报错
  const dead = setup([p], { fetcher: async () => { throw new TypeError('fetch failed') }, indexUrls: ['https://dead-1/index.json', 'https://dead-2/index.json'] })
  await assert.rejects(() => dead.m.list(), /连不上索引源/)
})

test('索引：schema 门禁；坏条目被滤掉不拒整个索引', async () => {
  const p = pack('schema-mod', '1.0.0')
  const bad = { id: 'no-sha', version: '1.0.0', path: 'x.zip' }
  const fetcher = async (url) => ({ ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: [p.entry, bad] }) })
  const list = await setup([p], { fetcher }).m.list()
  assert.deepEqual(list.list.map((e) => e.id), ['schema-mod'])
  const fetcher2 = async () => ({ ok: true, json: async () => ({ schema: 2, modules: [] }) })
  await assert.rejects(() => setup([], { fetcher: fetcher2 }).m.list(), /新版/)
})

// ---------------- 卸载 / delisted ----------------

test('卸载：只动市场装的；purge 清数据和配置；delisted 标记', async () => {
  const p = pack('remove-mod', '1.0.0')
  const dataRoot = join(root, 'modules-data', 'remove-mod')
  mkdirSync(dataRoot, { recursive: true })
  const { m, cfg } = setup([p], { cfg: { modules: { market: { enabled: true }, 'remove-mod': { enabled: true } }, ext: { 'remove-mod': { x: 1 } } } })
  assert.equal((await m.install('remove-mod')).ok, true)
  const r = await m.remove('remove-mod', { purge: true })
  assert.equal(r.ok, true)
  assert.equal(existsSync(join(userDir(), 'remove-mod')), false)
  assert.equal(existsSync(dataRoot), false)
  assert.equal(cfg().modules['remove-mod'], undefined)
  assert.equal(cfg().ext['remove-mod'], undefined)
  assert.equal(cfg().modules.market.installed['remove-mod'], undefined)
  // 不是市场装的不碰
  mkdirSync(join(userDir(), 'user-mod'), { recursive: true })
  const r2 = await m.remove('user-mod')
  assert.equal(r2.ok, false)
  assert.equal(existsSync(join(userDir(), 'user-mod')), true)
  // delisted：装着但索引下架
  const p2 = pack('gone-mod', '1.0.0')
  const t = setup([p2])
  assert.equal((await t.m.install('gone-mod')).ok, true)
  const t2 = setup([], { status: [{ id: 'gone-mod', name: 'gone', description: '' }] })
  const list = await t2.m.list()
  const g = list.list.find((x) => x.id === 'gone-mod')
  assert.equal(g.delisted, true)
})

test('进度：安装各阶段上报，装完清空', async () => {
  const p = pack('prog-mod', '1.0.0')
  const stages = []
  let m
  const fetcher = async (url) => {
    stages.push(m.progress()?.stage)
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://x/', modules: [p.entry] }) }
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const mods = { status: () => [], sync: async () => { stages.push(m.progress()?.stage) } }
  let config = { modules: { market: { enabled: true } } }
  m = createMarket({ mods, getConfig: () => config, setConfig: (n) => { config = n }, log: { warn() {}, debug() {} }, version: '1.4.3', fetcher, retryMs: 1, validateUrl: async () => {} })
  assert.equal((await m.install('prog-mod')).ok, true)
  assert.deepEqual(stages, ['index', 'download', 'start'])
  assert.equal(m.progress(), null)
})
