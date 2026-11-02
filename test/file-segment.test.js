
// 文件段处理链路的单元测试（不吃真实网络：用一个假的 onebot 调用器）
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageEvent } from '../src/chat/inbound.js'

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
