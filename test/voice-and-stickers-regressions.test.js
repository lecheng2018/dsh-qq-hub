// 回归：voice（tts.js 错误摘要 / engine=none / Int16Array 对齐 / edgeSynth stdin / cloud-asr openai 默认与响应体片段）
// 与 stickers（PROTECTED_FROM 含 qq & tool / validLibrary 防穿越 / pickForReply 否定词过滤 / caption 连续失败阈值+冷却恢复 / thumbFor 并发去重+原子 rename / importFromQQ 懒读盘）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { summarizeSubprocessError, textToSpeech, pcm16ToInt16Array } from '../src/voice/tts.js'
import { normalizeCloudAsrConfig, createCloudAsr } from '../src/voice/cloud-asr.js'
import { PROTECTED_FROM, createStickerStore, loadLibrary, pickForReply } from '../src/features/stickers.js'
import stickersMod from '../src/modules/stickers/index.js'

function png(salt, w = 200, h = 200) {
  const b = Buffer.alloc(160)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  b[40] = salt
  return b
}

// ---------------- Voice ----------------

test('tts.js summarizeSubprocessError：过滤 Python 3.11 ^^^ 行并提取最终异常行', () => {
  const py311Err = [
    'Traceback (most recent call last):',
    '  File "/opt/pyenv/lib/python3.11/site-packages/edge_tts/util.py", line 42, in main',
    '    with open(args.file, "r", encoding="utf-8") as file:',
    '         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    'UnicodeDecodeError: \'gbk\' codec can\'t decode byte 0x80 in position 2',
    '    ~~~~~~~~~~^',
  ].join('\n')
  const summary = summarizeSubprocessError(py311Err, '')
  assert.match(summary, /^UnicodeDecodeError:/)
  assert.equal(summary.includes('^^^'), false)
  assert.equal(summary.includes('f-8") as file:'), false)
})

test('tts.js：engine="none" 显式短路抛错，绝不静默落入 edgeSynth', async () => {
  await assert.rejects(
    () => textToSpeech('你好', { engine: 'none' }),
    /engine=none|已关闭/,
  )
})

test('tts.js：pcm16ToInt16Array 正确处理奇数 byteOffset Buffer', () => {
  const backing = Buffer.alloc(11)
  backing.writeInt16LE(1234, 1)
  backing.writeInt16LE(-5678, 3)
  const oddSlice = backing.subarray(1, 9) // byteOffset === 1（奇数）
  assert.equal(oddSlice.byteOffset % 2, 1)
  const arr = pcm16ToInt16Array(oddSlice)
  assert.equal(arr[0], 1234)
  assert.equal(arr[1], -5678)
})

test('tts.js：edgeSynth 改用 --file - 与 -X utf8，不再用 -I 或临时 .txt', () => {
  const src = readFileSync(new URL('../src/voice/tts.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('async function edgeSynth'), src.indexOf('async function windowsSynth'))
  assert.match(block, /'-X',\s*'utf8'/)
  assert.match(block, /'--file',\s*'-'/)
  assert.equal(block.includes("'-I'"), false)
  assert.equal(block.includes("await import('node:fs')"), false)
})

test('cloud-asr.js：openai provider 默认地址与模型正确，HTTP 错误带响应体片段', async () => {
  const oa = normalizeCloudAsrConfig({ cloudAsrEnabled: true, cloudAsrApiKey: 'test-key', cloudAsrProvider: 'openai' })
  assert.equal(oa.baseUrl, 'https://api.openai.com/v1')
  assert.equal(oa.model, 'whisper-1')

  const asr = createCloudAsr({
    getConfig: () => ({ ext: { voice: { cloudAsrEnabled: true, cloudAsrApiKey: 'test-key', cloudAsrProvider: 'openai' } } }),
    log: { warn() {} },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"invalid audio format"}}',
    }),
  })
  await assert.rejects(() => asr.transcribe(Buffer.from('x')), /HTTP 400.*invalid audio format/)
})

// ---------------- Stickers ----------------

test('stickers：PROTECTED_FROM 含 qq 与 tool，群友发言时禁止通过 qq_edit_sticker 删除主人收藏', async () => {
  assert.ok(PROTECTED_FROM.has('qq'))
  assert.ok(PROTECTED_FROM.has('tool'))
  assert.ok(PROTECTED_FROM.has('manual'))
  assert.ok(PROTECTED_FROM.has('panel'))
  assert.ok(PROTECTED_FROM.has('pack'))

  const dir = mkdtempSync(join(tmpdir(), 'qqhub-stk-prot-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  try {
    let toolBuilder = null
    let ownerSpeaking = false
    const cfg = { dryRun: true, stickers: { enabled: true, collect: true, caption: false } }
    const store = stickersMod.setup({
      dsh: {},
      config: () => cfg,
      log: { info() {}, warn() {}, debug() {} },
      core: {
        hub: { turnHasOwner: () => ownerSpeaking, turnSendersAllOwner: () => ownerSpeaking, sendSticker: async () => true },
        onebot: { call: async () => ({}) },
        http: { body: async () => ({}), query: () => ({}), send() {}, raw: async () => Buffer.alloc(0) },
      },
      tool(fn) { toolBuilder = fn },
      route() {},
      rule() {},
    })

    const rQQ = await store.addFromBuffer(png(1), { name: '主人收藏QQ', from: 'qq', toQQ: false })
    const rTool = await store.addFromBuffer(png(2), { name: '工具添加图', from: 'tool', toQQ: false })
    assert.equal(rQQ.ok, true)
    assert.equal(rTool.ok, true)

    const tools = toolBuilder({ chat: { chatId: 'group:888', kind: 'group' }, level: 'social', sessionId: 's1' })
    const editTool = tools.find((t) => t.name === 'qq_edit_sticker')

    ownerSpeaking = false
    const delQQ = await editTool.execute({ sticker: '主人收藏QQ', delete: true })
    assert.equal(delQQ.ok, false, '非主人开口不得删除 from=qq 表情')
    assert.match(delQQ.message, /主人/)

    const delTool = await editTool.execute({ sticker: '工具添加图', delete: true })
    assert.equal(delTool.ok, false, '非主人开口不得删除 from=tool 表情')
    assert.equal(store.library().items.length, 2)

    // 主人开口则允许删
    ownerSpeaking = true
    const delOk = await editTool.execute({ sticker: '工具添加图', delete: true })
    assert.equal(delOk.ok, true)
    assert.equal(store.library().items.length, 1)
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stickers validLibrary：拒绝含 .. 或路径分隔符的 item.file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-stk-valid-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  try {
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    writeFileSync(join(dir, 'stickers', 'index.json'), JSON.stringify({
      items: [{ md5: 'deadbeef', file: '../config.json', name: '越界' }],
    }), 'utf8')
    const warnings = []
    const lib = loadLibrary((e) => warnings.push(e.message))
    assert.deepEqual(lib.items, [], '含 .. 的非法索引应被拒绝并隔离')
    assert.ok(warnings.length > 0)
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stickers pickForReply：避开「不/别/没」前缀否定词误配', () => {
  const items = [
    { md5: 'happy', name: '大笑开心', tags: ['开心'], lastUsed: 0 },
    { md5: 'sad', name: '委屈巴巴', tags: ['委屈'], lastUsed: 0 },
  ]
  // 「不开心，好委屈」：跳过被否定的「开心」，命中「委屈」
  const hit1 = pickForReply(items, '今天一点都不开心，好委屈', { rand: () => 0.1 })
  assert.equal(hit1.md5, 'sad')

  const items2 = [
    { md5: 'angry', name: '气鼓鼓', tags: ['生气'], lastUsed: 0 },
    { md5: 'cute', name: '贴贴卖萌', tags: ['卖萌'], lastUsed: 0 },
  ]
  const hit2 = pickForReply(items2, '别生气啦，给你卖萌', { rand: () => 0.1 })
  assert.equal(hit2.md5, 'cute')

  const hit3 = pickForReply(items2, '没生气，只是想卖萌', { rand: () => 0.1 })
  assert.equal(hit3.md5, 'cute')

  // 正向命中照常工作
  const hit4 = pickForReply(items, '今天好开心呀', { rand: () => 0.1 })
  assert.equal(hit4.md5, 'happy')
})

test('stickers：thumbFor 并发去重与原子写入，无残留 tmp 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-stk-thumb-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  try {
    const store = createStickerStore({
      dsh: {},
      getConfig: () => ({ dryRun: true, stickers: { enabled: true, caption: false } }),
      onebot: { call: async () => ({}) },
      log: { info() {}, warn() {}, debug() {} },
    })
    const added = await store.addFromBuffer(png(77), { name: '并发缩略图', toQQ: false })
    const [t1, t2, t3] = await Promise.all([
      store.thumbFor(added.item.md5),
      store.thumbFor(added.item.md5),
      store.thumbFor(added.item.md5),
    ])
    assert.ok(t1 && t1.buf.length > 0)
    assert.deepEqual(t1.buf, t2.buf)
    assert.deepEqual(t2.buf, t3.buf)
    const leftover = readdirSync(join(dir, 'stickers')).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftover, [], '不得残留临时文件')
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stickers：importFromQQ 懒读盘起名 + caption 连续失败阈值与冷却自动恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-stk-cap-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  let attempts = 0
  let shouldFail = true
  // 假 DSH：支持看图，前 2 次抛错触发熔断冷却（阈值=2，冷却=60ms），冷却后恢复成功起名
  const llm = {
    resolveModelInfo: async () => ({ inputModalities: ['image'] }),
    async *stream() {
      attempts++
      if (shouldFail) throw new Error('temporary vision failure')
      yield { type: 'text-delta', text: '开心小猫 #开心' }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  }
  const fakeDsh = {
    llm,
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return null
    },
  }
  const until = async (pred, ms = 1000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  try {
    const store = createStickerStore({
      dsh: fakeDsh,
      getConfig: () => ({ dryRun: true, stickers: { enabled: true, caption: true } }),
      onebot: {
        call: async (action) => {
          if (action === 'fetch_custom_face') {
            return ['base64://' + png(91).toString('base64'), 'base64://' + png(92).toString('base64'), 'base64://' + png(93).toString('base64')]
          }
          return {}
        },
      },
      log: { info() {}, warn() {}, debug() {} },
      captionFailThreshold: 2,
      captionCooldownMs: 60,
    })

    // 通过 importFromQQ 导入 3 张（只传 md5 进队列懒读盘）：第 1、2 张失败触达阈值 2，第 3 张在冷却期内被跳过
    const imp = await store.importFromQQ()
    assert.equal(imp.ok, true)
    assert.equal(imp.added, 3)
    await until(() => attempts >= 2)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(attempts, 2, '连败 2 次进入冷却，第 3 张不再盲目请求模型')

    // 等冷却期过去后恢复正常，新收一张应自动恢复起名
    shouldFail = false
    await new Promise((r) => setTimeout(r, 90))
    const added4 = await store.addFromBuffer(png(94), { from: 'manual', toQQ: false })
    assert.equal(added4.ok, true)
    await until(() => Boolean(store.library().items.find((i) => i.md5 === added4.item.md5)?.name))
    const item4 = store.library().items.find((i) => i.md5 === added4.item.md5)
    assert.equal(item4.name, '开心小猫', '冷却过期后应自动恢复看图起名')
    assert.deepEqual(item4.tags, ['开心'])
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dir, { recursive: true, force: true })
  }
})
