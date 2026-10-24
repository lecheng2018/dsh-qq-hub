// 翻唱：截取位置、音色列表、网易云加密和 Cookie 解析、点歌的前置检查、/sing 命令。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let studio
let netease
let commands
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-song-'))
  studio = await import('../src/song/studio.js')
  netease = await import('../src/song/netease.js')
  commands = await import('../src/chat/commands.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

test('截一段：歌比上限长就从副歌附近截，短歌整首', () => {
  assert.deepEqual(studio.clipWindow(264, 120), { start: 79, length: 120 })
  assert.deepEqual(studio.clipWindow(264, 120, 'head'), { start: 0, length: 120 })
  assert.deepEqual(studio.clipWindow(90, 120), { start: 0, length: 90 })
  // 不会截到歌尾外面
  assert.deepEqual(studio.clipWindow(130, 120), { start: 10, length: 120 })
})

test('音色列表：models 目录里的 .pth，配同名 .index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voices-'))
  for (const n of ['voiceB.pth', 'voiceA.pth', 'added_IVF_voiceA.index', 'readme.txt']) writeFileSync(join(dir, n), 'x')
  const v = studio.listVoices(dir)
  assert.deepEqual(v.map((x) => x.id), ['voiceA', 'voiceB'])
  assert.ok(v[0].index.endsWith('added_IVF_voiceA.index'))
  assert.equal(v[1].index, '')
  assert.deepEqual(studio.listVoices(join(dir, 'nope')), [])
})

test('网易云：weapi 加密格式、Cookie 只取 MUSIC_U', () => {
  const f = netease.weapi({ s: '小幸运' })
  assert.match(f.params, /^[A-Za-z0-9+/=]+$/)
  assert.match(f.encSecKey, /^[0-9a-f]{256}$/)
  assert.notEqual(netease.weapi({ s: 'x' }).encSecKey, netease.weapi({ s: 'x' }).encSecKey, '每次随机密钥')
  assert.equal(netease.musicU('os=pc; MUSIC_U=abc123; __csrf=x'), 'abc123')
  assert.equal(netease.musicU('abc123'), 'abc123')
  assert.equal(netease.musicU('foo=bar'), '')
  assert.equal(netease.musicU(''), '')
})

test('点歌前置检查：没打开、没装好、没说歌名', () => {
  let cfg = normalize({ song: { enabled: false, root: mkdtempSync(join(tmpdir(), 'rvc-')) } })
  const s = studio.createSongStudio({ getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => {} })
  assert.match(s.request({ song: '小幸运', chatId: 'private:1' }).message, /还没打开/)
  cfg = normalize({ song: { ...cfg.song, enabled: true } })
  const r = s.request({ song: '小幸运', chatId: 'private:1' })
  assert.equal(r.ok, false)
  assert.match(r.message, /还没装好/)
  const st = s.status()
  assert.equal(st.ready, false)
  assert.equal(st.parts.python, false)
  assert.match(st.message, /导入/)
})

test('/sing：歌名和变调', async () => {
  const calls = []
  const deps = { getConfig: () => normalize({}), setConfig() {}, song: { request: (o) => { calls.push(o); return { ok: true, message: '开始准备' } } } }
  const msg = { kind: 'private', chatId: 'private:1', userId: '1' }
  assert.equal(await commands.runCommand(commands.parseCommand('/sing 小幸运 田馥甄 +12'), msg, deps), '开始准备')
  assert.deepEqual(calls[0], { song: '小幸运 田馥甄', pitch: 12, chatId: 'private:1' })
  await commands.runCommand(commands.parseCommand('/唱 晴天'), msg, deps)
  assert.deepEqual(calls[1], { song: '晴天', pitch: undefined, chatId: 'private:1' })
  assert.match(await commands.runCommand(commands.parseCommand('/sing'), msg, deps), /唱哪首/)
})

// 测试用的小 zip 打包器：deflate 压缩；name 可以传 Buffer（模拟 Windows 上 GBK 编码的中文文件名）
async function makeZip(entries) {
  const { deflateRawSync, crc32 } = await import('node:zlib')
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8')
    const flags = Buffer.isBuffer(e.name) ? 0 : 0x800
    const data = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, data)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const fakePth = (n = 2) => Buffer.concat([Buffer.from('PK'), Buffer.alloc(n * 1024 * 1024, 7)])

test('导入音色：zip 里的 .pth 和 .index 自动识别，单个音色时 index 自动配对，中文文件名不乱码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  const gbkName = Buffer.from([0xd0, 0xa1, 0xd3, 0xe3, 0x2e, 0x70, 0x74, 0x68]) // 「小鱼.pth」的 GBK 编码
  const zip = await makeZip([
    { name: gbkName, data: fakePth() },
    { name: 'logs/added_IVF256_Flat_nprobe_1_v2.index', data: Buffer.from('idx') },
    { name: '__MACOSX/._x.pth', data: Buffer.from('junk') },
    { name: 'readme.txt', data: Buffer.from('hi') },
  ])
  const r = studio.importModels(dir, 'models.zip', zip)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.added, ['小鱼'])
  const v = studio.listVoices(dir)
  assert.equal(v.length, 1)
  assert.equal(v[0].id, '小鱼')
  assert.ok(v[0].index.endsWith('小鱼.index'), '唯一的 index 自动配上')
})

test('导入音色：单个 .pth 直接导入；不是模型、不支持的格式会拒绝；可以删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  assert.equal(studio.importModels(dir, 'voiceX.pth', fakePth()).ok, true)
  assert.match(studio.importModels(dir, 'fake.pth', Buffer.from('hello')).message, /不是 RVC 模型/)
  assert.match(studio.importModels(dir, 'song.mp3', Buffer.from('x')).message, /只支持/)
  assert.throws(() => studio.importModels(dir, 'broken.zip', Buffer.from('not a zip')), /不是 zip/)
  assert.deepEqual(studio.listVoices(dir).map((x) => x.id), ['voiceX'])
  assert.equal(studio.deleteVoice(dir, 'voiceX').ok, true)
  assert.deepEqual(studio.listVoices(dir), [])
  // 文件名里带路径也只取文件名，不会写到 models 目录外面
  assert.equal(studio.importModels(dir, '..\\..\\evil.pth', fakePth()).ok, true)
  assert.deepEqual(studio.listVoices(dir).map((x) => x.id), ['evil'])
})

test('安装：报错翻译成人话、安装位置检查、列出各个盘', () => {
  assert.match(studio.explainInstallError('spawn uv ENOENT'), /找不到需要的程序（uv）/)
  assert.match(studio.explainInstallError('error sending request for url ... connection reset'), /国内镜像/)
  assert.match(studio.explainInstallError('30 秒没进度'), /超时/)
  assert.match(studio.explainInstallError('No space left on device'), /磁盘空间/)
  assert.equal(studio.checkRoot('rvc').ok, false)
  assert.equal(studio.checkRoot('').ok, true)
  assert.match(studio.checkRoot('C:\\我的 文件\\rvc').warn, /中文或空格/)
  assert.ok(studio.checkRoot('C:\\Aurabot\\rvc').freeGB > 0)
  const drives = studio.listDrives()
  assert.ok(drives.some((d) => d.drive === 'C:' && d.root === 'C:\\Aurabot\\rvc' && d.totalGB > 0))
  assert.equal(studio.INSTALL_STEPS.length, 5)
})
