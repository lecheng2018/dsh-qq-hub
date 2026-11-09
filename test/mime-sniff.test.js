// 图片类型嗅探：QQ 表情包常见 webp / gif / png，认不出就不能静默丢弃。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { mimeOf } = await import(`file:///${REPO}/src/chat/inbound.js`)

const head = (bytes) => { const b = Buffer.alloc(64); Buffer.from(bytes).copy(b); return b }

test('常见图片格式都认得出', () => {
  assert.equal(mimeOf(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png')
  assert.equal(mimeOf(head([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(mimeOf(head([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(mimeOf(head([0x42, 0x4d])), 'image/bmp')
})

test('WEBP 必须看第 9~12 字节，不能只看 RIFF', () => {
  const webp = Buffer.alloc(64)
  webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii')
  assert.equal(mimeOf(webp), 'image/webp', 'REAL WEBP')
  const riffOnly = Buffer.alloc(64) // 只有 RIFF 头，不是 webp（可能是 wav/avi）
  riffOnly.write('RIFF', 0, 'ascii'); riffOnly.write('WAVE', 8, 'ascii')
  assert.equal(mimeOf(riffOnly), 'application/octet-stream', '不是 webp 就不能当图片')
})

test('AVIF / HEIC 按 ftyp 分支识别', () => {
  const avif = Buffer.alloc(64); avif.write('ftyp', 4, 'ascii'); avif.write('avif', 8, 'ascii')
  assert.equal(mimeOf(avif), 'image/avif')
  const heic = Buffer.alloc(64); heic.write('ftyp', 4, 'ascii'); heic.write('heic', 8, 'ascii')
  assert.equal(mimeOf(heic), 'image/heic')
})

test('不是图片就明确返回 octet-stream（调用方据此记账，而不是静默丢）', () => {
  assert.equal(mimeOf(Buffer.from('hello world, this is text')), 'application/octet-stream')
  assert.equal(mimeOf(Buffer.alloc(0)), 'application/octet-stream')
  assert.equal(mimeOf(null), 'application/octet-stream')
})

test('短得没法判的字节不抛异常', () => {
  assert.equal(mimeOf(Buffer.from([0x89])), 'application/octet-stream')
  assert.equal(mimeOf(Buffer.alloc(11)), 'application/octet-stream')
})
