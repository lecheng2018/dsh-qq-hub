import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDiaryTimes } from '../src/features/qzone.js'
import { moodLabel, scoreText, decayed } from '../src/features/companion.js'
import { matchSticker, pickForReply } from '../src/features/stickers.js'
import { pickBotProcess, readOneBotEndpoint } from '../src/snowluma/manager.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('日记排期：窗口内、间隔够、按时间排序', () => {
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 50; i++) {
    const t = planDiaryTimes({ timesPerDay: 2, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 }, rand)
    assert.equal(t.length, 2)
    assert.ok(t[0] >= 600 && t[1] < 1410)
    assert.ok(t[1] - t[0] >= 180)
  }
  assert.deepEqual(planDiaryTimes({ timesPerDay: 0, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 }), [])
})

test('心情：关键词推动、半衰期回落', () => {
  assert.ok(scoreText('你好可爱 爱你') > 0)
  assert.ok(scoreText('滚 烦死了') < 0)
  assert.equal(scoreText('今天下雨'), 0)
  assert.equal(Math.round(decayed(100, 0, 3, 3 * 3600_000)), 80)
  assert.equal(moodLabel(90), '超开心')
  assert.equal(moodLabel(20), '不太开心')
})

test('表情匹配：按名字和标签', () => {
  const items = [{ md5: 'a', name: '委屈巴巴的小猫', tags: ['委屈'] }, { md5: 'b', name: '得意叉腰', tags: ['开心'] }]
  assert.equal(matchSticker(items, '委屈').md5, 'a')
  assert.equal(matchSticker(items, '开心').md5, 'b')
  assert.equal(matchSticker(items, '完全无关xyz'), null)
  assert.equal(pickForReply(items, '哼 好委屈').md5, 'a')
})

test('只挑机器人号的 QQ 进程，识别不了就不注入', () => {
  const list = [{ pid: 1, account: { uin: 10000001 } }, { pid: 2, account: { uin: 20000002 } }]
  assert.equal(pickBotProcess(list, '20000002').proc.pid, 2)
  assert.equal(pickBotProcess([{ pid: 1, account: { uin: 10000001 } }], '20000002').proc, null)
  assert.equal(pickBotProcess([{ pid: 1, account: null }, { pid: 3, account: null }], '20000002').proc, null)
  assert.equal(pickBotProcess([...list, { pid: 5, account: { uin: 20000002 } }], '20000002').proc, null, '两个进程都声称是机器人号时不注入')
})

test('从 SnowLuma 配置读出 OneBot 地址和令牌（单号覆盖全局）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify({ networks: { httpServers: [{ host: '127.0.0.1', port: 3000, accessToken: 'g1' }], wsServers: [{ host: '0.0.0.0', port: 3001, accessToken: 'g2' }] } }))
  writeFileSync(join(dir, 'config', 'onebot_20000002.json'), JSON.stringify({ mode: 'overlay', networks: { httpServers: [{ host: '127.0.0.1', port: 3100, accessToken: 'u1' }] } }))
  const ep = readOneBotEndpoint(dir, '20000002')
  assert.equal(ep.httpUrl, 'http://127.0.0.1:3100')
  assert.equal(ep.httpToken, 'u1')
  assert.equal(ep.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(ep.wsToken, 'g2')
})

test('WAV 转 16kHz 单声道（给 DSH 语音识别）', async () => {
  const { buildWav, parseWav, toMono16k } = await import('../src/voice/wav.js')
  // 48kHz 立体声 0.5 秒
  const frames = 24000
  const pcm = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(i / 10) * 8000); pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2) }
  const head = buildWav(new Int16Array(0), 48000)
  head.writeUInt16LE(2, 22); head.writeUInt32LE(48000 * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt32LE(pcm.length, 40); head.writeUInt32LE(36 + pcm.length, 4)
  const out = parseWav(toMono16k(Buffer.concat([head, pcm])))
  assert.equal(out.rate, 16000)
  assert.equal(out.channels, 1)
  assert.equal(out.bits, 16)
  assert.equal(out.data.length / 2, 8000)
})

test('记忆检索：切词、相关度、去重', async () => {
  const { tokenize, buildIndex, search, similarity } = await import('../src/features/memory.js')
  assert.deepEqual(tokenize('喜欢吃白米饭'), ['喜欢', '欢吃', '吃白', '白米', '米饭'])
  const items = [
    { id: 'a', text: '主人最爱吃白米饭', importance: 0.8, at: Date.now() },
    { id: 'b', text: '主人周末喜欢打游戏', importance: 0.5, at: Date.now() },
    { id: 'c', text: '小明养了一只橘猫', importance: 0.5, at: Date.now(), about: '123' },
  ]
  const idx = buildIndex(items)
  assert.equal(search(idx, '中午吃米饭吗')[0].it.id, 'a')
  assert.equal(search(idx, '今天打游戏')[0].it.id, 'b')
  assert.equal(search(idx, '你好', { about: '123' })[0].it.id, 'c', '关于当前说话人的记忆有加权')
  assert.equal(search(idx, '量子力学').length, 0)
  assert.ok(similarity('主人最爱吃白米饭', '主人最爱吃白米饭了') > 0.6)
})
