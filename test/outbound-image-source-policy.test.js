// 审计 S01 的回归锁：
// 模型回复里的图片来源不能当成本机路径去读。
//
// 攻击面：模型输出 `![](/etc/passwd)` → reply.js 解析成 image 条目 →
// reply-delivery → outbound.sendImage → fetchImage(..., { allowLocal: true })
// → net.js 的 readFileSync(p)。整条路绕开了文件工具的目录白名单，且发生在投递之前。
//
// 修复：模型回复这条通路只接受 http(s) 与 base64。本机文件要么来自扩展/模块的
// 显式调用（那里自己传 allowLocal），要么来自入站媒体缓存句柄，都不走这条。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOutbound } from '../src/chat/outbound.js'
import { parseReply } from '../src/chat/reply.js'

const log = { info() {}, warn() {}, debug() {} }

function outboundFixture() {
  const sent = []
  const outbox = {
    request: async (req) => { sent.push(req); return { state: 'sent', raw: { message_id: 1 } } },
    reserve: () => ({ ticket: 't', release() {} }),
  }
  const outbound = createOutbound({
    getConfig: () => ({
      ownerQQ: '1', botQQ: '2', enabled: true, dryRun: false,
      stickers: { enabled: false, faces: false },
      voice: { enabled: false },
    }),
    log,
    onebot: { call: async () => [] },
    outbox,
    groups: { cachedMembers: () => [{}], setMembers() {}, staleMembers: () => [], refs: () => ({}) },
    stickers: { match: () => null, markUsed() {}, segmentFor: () => null },
    tts: {},
    interaction: { facesUsed: () => new Set(), rememberFaces() {} },
    onStats() {},
  })
  return { outbound, sent }
}

test('S01 · parseReply 确实会把 ![](路径) 解析成 image 条目（攻击面存在）', () => {
  // 先钉住上游事实：不修的话模型输出就是这么变成 image 条目的。
  const r = parseReply('看这个![](/etc/passwd)')
  assert.ok(
    r.items.some((i) => i.kind === 'image' && i.value === '/etc/passwd'),
    JSON.stringify(r.items),
  )
})

test('S01 · sendImage 拒绝本机绝对路径，不读文件', async () => {
  const { outbound, sent } = outboundFixture()
  const result = await outbound.sendImage('private:1', '/etc/passwd')
  assert.equal(result, null, '必须发不出去')
  assert.equal(sent.length, 0, '不得产生任何出站请求')
})

test('S01 · sendImage 拒绝 Windows 绝对路径', async () => {
  const { outbound, sent } = outboundFixture()
  const result = await outbound.sendImage('private:1', 'C:\\Windows\\win.ini')
  assert.equal(result, null)
  assert.equal(sent.length, 0)
})

test('S01 · sendImage 拒绝 file:// 与相对路径', async () => {
  const { outbound, sent } = outboundFixture()
  assert.equal(await outbound.sendImage('private:1', 'file:///etc/passwd'), null)
  assert.equal(await outbound.sendImage('private:1', '../../etc/passwd'), null)
  assert.equal(sent.length, 0)
})

test('S01 · sendMixed 里的 image part 同样拒绝本机路径', async () => {
  const { outbound, sent } = outboundFixture()
  // mixed 里只有一个不可发的图片 part：整泡没有可发内容，不应产生出站请求
  const result = await outbound.sendMixed('private:1', [{ kind: 'image', value: '/etc/passwd' }], null, [], 'u1')
  assert.equal(sent.length, 0, '不得把本机文件发出去')
  assert.ok(result === null || result === undefined || sent.length === 0)
})

test('S01 · base64:// 与 http(s) 仍然可用（正常业务不受影响）', async () => {
  const { outbound } = outboundFixture()
  // base64 是最常用的一条（很多来源已经是 base64）：不应该被拦住
  const b64 = await outbound.sendImage('private:1', 'base64://' + Buffer.from('hello').toString('base64'))
  assert.ok(b64, 'base64 图片必须能发出去')
})

test('S01 · 不存在的本机路径也不泄露"文件存在与否"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's01-'))
  try {
    const real = join(dir, 'secret.txt')
    writeFileSync(real, 'TOP-SECRET')
    const { outbound, sent } = outboundFixture()
    // 存在与不存在必须给出同样的结果（都发不出去），否则可被当探测手段
    const a = await outbound.sendImage('private:1', real)
    const b = await outbound.sendImage('private:1', join(dir, 'nope.txt'))
    assert.equal(a, null)
    assert.equal(b, null)
    assert.equal(sent.length, 0)
    assert.ok(existsSync(real), '文件本身不应被删除或改写')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})