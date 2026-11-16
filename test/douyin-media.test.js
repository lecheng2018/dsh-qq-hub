import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { downloadVideo, safeName } from '../src/douyin/media.js'

// 这组用例盯住「把视频真正发出去」这条路：
// 以前抖音只发文字摘要 + 链接，主人收不到视频本身。

test('safeName 清掉文件名里不能用的字符', () => {
  const n = safeName('符仙人：符道之祖 #短剧/第1集', '7661969723730447616')
  assert.ok(!/[:\\/?*"<>|]/.test(n), '不该残留非法字符：' + n)
  assert.ok(n.endsWith('.mp4'), '扩展名要保留')
  assert.ok(n.includes('7661969723730447616'), '要带视频 id 防止重名')
})

test('safeName 标题为空时只用 id', () => {
  const n = safeName('', '123456')
  assert.equal(n, '123456.mp4')
})

test('safeName 超长标题会被截断', () => {
  const n = safeName('长'.repeat(200), '999')
  assert.ok(n.length < 100, '不该无限制拉长：' + n.length)
})

test('没有视频地址时给出明确错误（图文作品同理）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-media-'))
  await assert.rejects(
    () => downloadVideo({ awemeId: '1', videoUrls: [] }, { dir }),
    /没拿到视频地址|图文/,
  )
  await assert.rejects(
    () => downloadVideo({ awemeId: '1', videoUrls: [], isImages: true }, { dir }),
    /图文/,
  )
})

test('没给下载目录时不许瞎写', async () => {
  await assert.rejects(
    () => downloadVideo({ awemeId: '1', videoUrls: ['https://x/y.mp4'] }, {}),
    /下载目录/,
  )
})

test('体积超限会拒绝，且不留下半截文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-media2-'))
  // 指向一个必然超小上限的地址；拿不到内容时也应报错而不是留垃圾
  const urls = ['http://127.0.0.1:9/never.mp4']
  await assert.rejects(
    () => downloadVideo({ awemeId: '1', title: 'limit', videoUrls: urls }, { dir, maxMB: 0.00001 }),
  )
  const left = readdirSync(dir)
  assert.deepEqual(left, [], '失败后目录里不该留 .part 之类的残骸：' + JSON.stringify(left))
})

test('downloadVideo 下载时不带 range: bytes=0- 请求头，并正确透传 Referer', async () => {
  let capturedHeaders = null
  const server = createServer((req, res) => {
    capturedHeaders = req.headers
    const dummyVideo = Buffer.alloc(2048, 0x42)
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(dummyVideo.length),
    })
    res.end(dummyVideo)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = mkdtempSync(join(tmpdir(), 'dy-media-mock-'))

  try {
    const res = await downloadVideo(
      { awemeId: '888999', title: 'mock-video', videoUrls: [`http://127.0.0.1:${port}/video.mp4`] },
      { dir, referer: 'https://www.bilibili.com/' },
    )
    assert.ok(capturedHeaders, '服务端应收到请求')
    assert.equal(capturedHeaders.range, undefined, '不应发送 range 请求头（否则触发 CDN 限速挂起）')
    assert.equal(capturedHeaders.referer, 'https://www.bilibili.com/', '应使用传入的 referer')
    assert.ok(res.path.endsWith('.mp4'), '落盘路径应为 mp4')
    assert.equal(statSync(res.path).size, 2048, '下载文件大小应与内容一致')
  } finally {
    server.close()
  }
})
