import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { UV_SOURCES } from '../src/voice/uv.js'

test('UV_SOURCES：长度 3，首条走阿里云镜像且带 sha256，前两条校验值一致', () => {
  assert.equal(UV_SOURCES.length, 3)
  assert.ok(UV_SOURCES[0].url.includes('mirrors.aliyun.com'))
  assert.ok(UV_SOURCES[0].sha256)
  assert.equal(UV_SOURCES[0].sha256, UV_SOURCES[1].sha256)
})

test('tts.js 不再依赖 song 目录（防止解耦回退）', () => {
  const src = readFileSync(new URL('../src/voice/tts.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('/song'), 'tts.js 不应再引用 song 模块')
})

test('UV_SOURCES 每条都有 https 开头的 url', () => {
  for (const s of UV_SOURCES) assert.ok(s.url && s.url.startsWith('https:'))
})
