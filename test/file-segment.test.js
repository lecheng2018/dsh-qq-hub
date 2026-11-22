
// 文件段处理链路的单元测试（不吃真实网络：用一个假的 onebot 调用器）
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { fileSegmentBytes } from '../src/core/net.js'
import { inboundFileBlocks, inboundFileMaxBytes, readInboundFiles } from '../src/chat/inbound-files.js'
import { normalize } from '../src/core/config.js'

const evt = (segs, extra = {}) => ({
  message_type: 'private', user_id: '111', self_id: '999',
  raw_message: '', message: segs, sender: { nickname: '主人' }, ...extra,
})

test('file 段会被收集进 files，不再是纯文本占位', () => {
  const m = parseMessageEvent(evt([{ type: 'file', data: { file: 'a.md', file_id: '/abc', file_name: 'a.md', file_size: '1234' } }]), '999')
  assert.equal(m.files.length, 1, '必须收到 1 个文件段')
  assert.equal(m.files[0].data.file_id, '/abc')
})

test('文件消息仍然带一行文字占位（她要能知道有人发了文件）', () => {
  const m = parseMessageEvent(evt([{ type: 'file', data: { file_name: '报告.md', file_id: '/x' } }]), '999')
  assert.match(m.text, /\[文件 报告\.md\]/)
})

test('没写 file_name 时退回 file 字段，不会出现 [文件 ]', () => {
  const m = parseMessageEvent(evt([{ type: 'file', data: { file: 'b.txt' } }]), '999')
  assert.match(m.text, /b\.txt/)
})

test('一条消息里多个文件都能收到', () => {
  const m = parseMessageEvent(evt([
    { type: 'file', data: { file_id: '/1', file_name: 'a.md' } },
    { type: 'file', data: { file_id: '/2', file_name: 'b.json' } },
  ]), '999')
  assert.equal(m.files.length, 2)
})

test('群消息的 file 段同样收集，且保留 groupId 供 get_group_file_url 用', () => {
  const m = parseMessageEvent(evt([{ type: 'file', data: { file_id: '/g1', file_name: 'c.py', busid: '102' } }], { message_type: 'group', group_id: '555' }), '999')
  assert.equal(m.files.length, 1)
  assert.equal(m.kind, 'group')
  assert.equal(m.groupId, '555')
  assert.equal(String(m.files[0].data.busid), '102')
})

test('纯文字消息的 files 是空数组，不是 undefined', () => {
  const m = parseMessageEvent(evt([{ type: 'text', data: { text: '你好' } }]), '999')
  assert.deepEqual(m.files, [])
})

test('图片和文件混发：各归各的，不串', () => {
  const m = parseMessageEvent(evt([
    { type: 'image', data: { url: 'https://example.com/a.png' } },
    { type: 'file', data: { file_id: '/f1', file_name: 'd.md' } },
  ]), '999')
  assert.equal(m.images.length, 1)
  assert.equal(m.files.length, 1)
})

test('直接给 url/base64 时也先检查声明大小，不绕过上限', async () => {
  const seg = { type: 'file', data: { file_name: '大文件.bin', file_size: 2048, base64: 'base64://AAE=' } }
  await assert.rejects(fileSegmentBytes(seg, null, { maxBytes: 1024 }), /文件太大/)
})

test('超过 3 个文件时明确告诉模型剩余文件未读取', async () => {
  const files = ['一.txt', '二.txt', '三.txt', '四.txt'].map((name) => ({
    type: 'file', data: { file_name: name, base64: `base64://${Buffer.from(name).toString('base64')}` },
  }))
  const got = await readInboundFiles({ kind: 'private', userId: '111', files }, { workspaceDir: '/tmp' })
  assert.equal(got.length, 4)
  const text = inboundFileBlocks(got, '主人').map((block) => block.text).join('\n')
  assert.match(text, /四\.txt/)
  assert.match(text, /最多.*3/)
})

test('小于 1KB 的文件不会显示成 0KB', async () => {
  const got = await readInboundFiles({ kind: 'private', userId: '111', files: [
    { type: 'file', data: { file_name: '小.txt', base64: `base64://${Buffer.from('abc').toString('base64')}` } },
  ] }, { workspaceDir: '/tmp' })
  const text = inboundFileBlocks(got, '主人')[0].text
  assert.match(text, /<1KB/)
  assert.doesNotMatch(text, /0KB/)
})

test('入站文件上限跟随 files.maxMB，不再写死 20MB（主人发的 37MB 包能取下来）', async () => {
  const seg = {
    type: 'file',
    data: { file_name: 'SG350H测试版1.0.0及刷机教程.zip', file_size: 37 * 1024 * 1024, base64: 'base64://AAE=' },
  }
  // 旧行为：20MB 硬上限，挡在下载前，模型只能看到「没取下来」
  const old = await readInboundFiles({ kind: 'private', userId: '111', files: [seg] }, { workspaceDir: '/tmp', maxBytes: 20 * 1024 * 1024 })
  assert.equal(old[0].kind, 'failed')
  assert.match(old[0].reason, /文件太大/)

  // panel 里 files.maxMB = 100 换算出来的上限：能落盘，并把路径交给她
  const got = await readInboundFiles({ kind: 'private', userId: '111', files: [seg] }, { workspaceDir: '/tmp', maxBytes: inboundFileMaxBytes({ files: { maxMB: 100 } }) })
  assert.equal(got[0].kind, 'file')
  assert.equal(got[0].name, 'SG350H测试版1.0.0及刷机教程.zip')
  assert.match(got[0].path, /qq-inbox\//)
  assert.match(inboundFileBlocks(got, '主人')[0].text, /已经存在/)
})

test('收文件上限优先取 files.inboundMaxMB，老配置没这个键才回落 files.maxMB', () => {
  // 上下行分开配：出站 200、入站 30，各走各的
  assert.equal(inboundFileMaxBytes({ files: { inboundMaxMB: 30, maxMB: 200 } }), 30 * 1024 * 1024)
  // 老配置（只有 maxMB）：沿用，行为不突变
  assert.equal(inboundFileMaxBytes({ files: { maxMB: 100 } }), 100 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes(undefined), 50 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes({ files: {} }), 50 * 1024 * 1024)
  // 非法值一律回落到 50MB，不会被 ?/|| 的坑吃成 NaN 或 0
  assert.equal(inboundFileMaxBytes({ files: { inboundMaxMB: 0, maxMB: 200 } }), 50 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes({ files: { inboundMaxMB: 'abc' } }), 50 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes({ files: { maxMB: 0 } }), 50 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes({ files: { maxMB: 'abc' } }), 50 * 1024 * 1024)
  // 硬顶 256MB
  assert.equal(inboundFileMaxBytes({ files: { inboundMaxMB: 9999 } }), 256 * 1024 * 1024)
  assert.equal(inboundFileMaxBytes({ files: { maxMB: 9999 } }), 256 * 1024 * 1024)
})

test('files.inboundMaxMB 归一化：默认 50、1~256 之外收回区间、与 files.maxMB 互不影响', () => {
  const n = normalize({ files: { maxMB: 200, inboundMaxMB: 30 } })
  assert.equal(n.files.maxMB, 200)
  assert.equal(n.files.inboundMaxMB, 30)
  // 老配置没有 inboundMaxMB：给默认 50，不跟着 maxMB 变成 200
  assert.equal(normalize({ files: { maxMB: 200 } }).files.inboundMaxMB, 50)
  assert.equal(normalize({ files: {} }).files.inboundMaxMB, 50)
  assert.equal(normalize({ files: { inboundMaxMB: 0 } }).files.inboundMaxMB, 50)
  assert.equal(normalize({ files: { inboundMaxMB: 'abc' } }).files.inboundMaxMB, 50)
  // 与 inboundFileMaxBytes 的硬顶对齐，面板填不出「会被悄悄截断」的值
  assert.equal(normalize({ files: { inboundMaxMB: 9999 } }).files.inboundMaxMB, 256)
})
