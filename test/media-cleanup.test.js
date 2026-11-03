import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { discardDownloaded, sweepMediaDir } from '../src/douyin/media.js'
import { deliverParseResult } from '../src/modules/multi-parser/delivery.js'

// 解析下载的视频以前只下不删，长期跑会把盘吃满。
// 这里守住「发完即删」和「启动兜底清扫」两条线。

function tmp() {
  return mkdtempSync(join(tmpdir(), 'media-clean-'))
}

function fakeApi(dir, sent = []) {
  return {
    config: () => ({ botQQ: '10000', files: { maxMB: 50 } }),
    workspaceDir: () => dir,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    async sendText(chatId, text) { sent.push(['text', text]) },
    async sendFile(chatId, file, name) { sent.push(['file', file, name]) },
    async sendSegments(chatId, segs) { sent.push(['segments', segs]) },
    async onebot(action, params) { sent.push(['onebot', action, params]) },
  }
}

/** 起一个本地服务，返回一段「看起来像视频」的字节（>1KB，否则会被判太小）。 */
async function serveVideo(size = 4096) {
  const body = Buffer.alloc(size, 1)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(size) })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { server, url: `http://127.0.0.1:${port}/v.mp4` }
}

test('discardDownloaded：删掉已下载的文件并返回 true', () => {
  const dir = tmp()
  const f = join(dir, 'a.mp4')
  writeFileSync(f, 'x')
  assert.equal(existsSync(f), true)
  assert.equal(discardDownloaded(f), true)
  assert.equal(existsSync(f), false)
})

test('discardDownloaded：文件不存在/空路径不抛错，返回 false', () => {
  assert.equal(discardDownloaded(''), false)
  assert.equal(discardDownloaded(join(tmp(), 'nope.mp4')), false)
})

test('sweepMediaDir：清掉超龄残留，保留新鲜的', () => {
  const dir = tmp()
  const old = join(dir, 'old.mp4')
  const fresh = join(dir, 'fresh.mp4')
  writeFileSync(old, 'old')
  writeFileSync(fresh, 'fresh')
  const tenHoursAgo = Date.now() - 10 * 3600_000
  utimesSync(old, tenHoursAgo / 1000, tenHoursAgo / 1000)

  const r = sweepMediaDir(dir, { maxAgeMs: 6 * 3600_000, maxBytes: 1024 * 1024 })
  assert.equal(r.removed, 1)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
})

test('sweepMediaDir：总量超限时从最旧的删起', () => {
  const dir = tmp()
  const names = []
  for (let i = 0; i < 3; i++) {
    const f = join(dir, `v${i}.mp4`)
    writeFileSync(f, Buffer.alloc(400))
    const t = Date.now() - (10 - i) * 3600_000
    utimesSync(f, t / 1000, t / 1000)
    names.push(f)
  }
  const r = sweepMediaDir(dir, { maxAgeMs: 100 * 3600_000, maxBytes: 900 })
  assert.ok(r.removed >= 1)
  assert.equal(existsSync(names[0]), false, '最旧的先被删')
  assert.equal(existsSync(names[2]), true, '最新的留着')
})

test('sweepMediaDir：keep 指定的最近文件即使超龄也不删', () => {
  const dir = tmp()
  const a = join(dir, 'a.mp4')
  const b = join(dir, 'b.mp4')
  writeFileSync(a, 'a')
  writeFileSync(b, 'b')
  const old = Date.now() - 100 * 3600_000
  utimesSync(a, old / 1000, old / 1000)
  utimesSync(b, old / 1000, old / 1000)

  const r = sweepMediaDir(dir, { maxAgeMs: 3600_000, maxBytes: 1024, keep: 1 })
  assert.equal(r.removed, 1, '只删掉 keep 之外的')
  assert.equal(readdirSync(dir).length, 1)
})

test('sweepMediaDir：目录不存在时安静返回', () => {
  const r = sweepMediaDir(join(tmp(), 'not-there'), {})
  assert.deepEqual(r, { removed: 0, bytes: 0 })
  assert.equal(sweepMediaDir('', {}).removed, 0)
})

test('deliverParseResult：视频真的发出去后，本地文件立刻被删', async () => {
  const dir = tmp()
  const { server, url } = await serveVideo()
  try {
    const sent = []
    const api = fakeApi(dir, sent)
    const result = {
      platformName: 'B站',
      title: '测试视频',
      author: 'up',
      summary: '',
      videoUrl: url,
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      images: [],
      type: 'video',
    }
    const ok = await deliverParseResult(api, 'private:1', result, { maxVideoMB: 50, sendMedia: true })
    assert.equal(ok, true)
    // 确实发出去了一个本地文件
    const fileCall = sent.find((s) => s[0] === 'file')
    assert.ok(fileCall, '应该调用了 sendFile 发本地视频')
    // 但发完之后，目录里不该还留着它
    assert.equal(existsSync(fileCall[1]), false, '发出去之后本地文件必须被删掉')
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.mp4')), [])
  } finally {
    server.close()
  }
})

test('deliverParseResult：下载失败时不留半成品', async () => {
  const dir = tmp()
  const api = fakeApi(dir)
  const result = {
    platformName: 'B站',
    title: '下载不了的视频',
    author: 'up',
    summary: '',
    videoUrl: 'http://127.0.0.1:1/none.mp4',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    images: [],
    type: 'video',
  }
  await deliverParseResult(api, 'private:1', result, { maxVideoMB: 50, sendMedia: true })
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.mp4')), [], '下载失败不该留下半成品')
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.part')), [], '不该留下 .part')
})
