// 审计 S02 / S03 的回归锁：
//   S02 · 入站图片的 http(s) 下载必须走统一出口（逐跳 public-only + 流式上限 + 禁自动跳转），
//         不能再用裸 fetch —— 网关给的地址是半可信输入。
//   S03 · 入站附件落盘时不得采信网关注入的文件名（Windows 分隔符 + `..` 段可穿出收件目录）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInboundImages } from '../src/chat/inbound-images.js'
import { readInboundFiles } from '../src/chat/inbound-files.js'

const log = { info() {}, warn() {}, debug() {} }

/** 一个只回固定字节的本地 HTTP 服务。 */
async function serve(body, { status = 200, headers = {} } = {}) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'image/png', ...headers })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/img.png`, close: () => new Promise((r) => server.close(r)) }
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

test('S02 · 回环地址的入站图片被拒（SSRF）', async () => {
  const srv = await serve(PNG)
  try {
    const images = createInboundImages({ onebot: {}, dsh: {}, log })
    await assert.rejects(
      () => images.read({ url: srv.url }),
      /内网|本机|不允许/i,
      '回环/内网地址必须在下载前被 assertPublicUrl 拦下',
    )
  } finally { await srv.close() }
})

test('S02 · base64:// 仍然可用（正常路径不受影响）', async () => {
  const images = createInboundImages({ onebot: {}, dsh: {}, log })
  const out = await images.read({ url: 'base64://' + PNG.toString('base64') })
  assert.equal(out.mediaType, 'image/png')
  assert.equal(out.data, PNG.toString('base64'))
})

test('S02 · 非 http(s)/base64 的地址被拒', async () => {
  const images = createInboundImages({ onebot: {}, dsh: {}, log })
  await assert.rejects(() => images.read({ url: 'ftp://example.com/a.png' }), /不认识的地址|不是可下载/)
  await assert.rejects(() => images.read({ url: 'file:///etc/passwd' }), /不认识的地址|不是可下载/)
})

test('S03 · Windows 分隔符与 .. 段都不能穿出收件目录', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qq-inbox-'))
  try {
    const evil = ['..\\..\\..\\Windows\\Temp\\pwn.exe', '../../../../tmp/pwn.bin', '..\\..\\x.exe']
    // 段自带 base64（少数实现会给），这样不必走网关换地址，测试只盯落盘路径
    const payload = 'base64://' + Buffer.from([0, 1, 2, 0, 255]).toString('base64')
    const files = evil.map((file_name) => ({ type: 'file', data: { file_name, base64: payload } }))
    const msg = { kind: 'private', userId: '1', files }

    // 假网关：不管要哪个 file_id 都回一段二进制（不是文本，所以会走落盘分支）
    const onebot = {
      call: async () => ({ base64: Buffer.from([0, 1, 2, 3, 0, 255]).toString('base64') }),
    }

    const out = await readInboundFiles(msg, { onebot, workspaceDir: workspace, log })
    const written = out.filter((x) => x.kind === 'file')
    assert.ok(written.length > 0, '应当有文件落盘：' + JSON.stringify(out))

    const inbox = join(workspace, 'qq-inbox')
    for (const item of written) {
      assert.equal(
        item.path.slice(0, inbox.length), inbox,
        `落盘路径必须在收件目录内：${item.path}`,
      )
      assert.ok(!item.path.includes('..'), '落盘路径不得含 .. 段')
      // 磁盘名是服务端生成的：不含原始文件名里的路径片段
      assert.ok(!/[\\/]/.test(item.path.slice(inbox.length + 1)), '磁盘名不得含任何分隔符')
    }
    // 原始文件名只作为展示字段保留（不参与路径）
    assert.ok(written.some((x) => x.name === evil[0]), '原始名仍用于展示')

    // 目录里确实只有收件目录自己的文件
    const inside = readdirSync(inbox)
    assert.equal(inside.length, written.length, '收件目录内文件数应与回报一致')
    for (const name of inside) assert.ok(!name.includes('..'), `目录内不得出现 .. : ${name}`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('S03 · 落盘名是服务端生成的 UUID，不含网关给的原始名', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qq-inbox-'))
  try {
    const payload = 'base64://' + Buffer.from([0, 1, 2, 0, 255]).toString('base64')
    const msg = { kind: 'private', userId: '1', files: [{ type: 'file', data: { file_name: 'report.exe', base64: payload } }] }
    const onebot = { call: async () => ({}) }
    const out = await readInboundFiles(msg, { onebot, workspaceDir: workspace, log })
    const file = out.find((x) => x.kind === 'file')
    assert.ok(file, '应当落盘')
    assert.ok(!file.path.includes('report'), '磁盘名不得包含原始文件名')
    assert.match(file.path, /\.[a-z0-9]{1,10}$/, '扩展名在白名单内')
    assert.equal(file.name, 'report.exe', '展示名保留原始文件名')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})