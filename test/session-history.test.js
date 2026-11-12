// 会话历史提取（1.3.63）：从 DSH 会话记录里翻群友原话，给蒸馏群友当证据源。
// chatlog 每天整理完就删，只留最近几天；会话记录留得久，能「立刻学」不用等。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { escapeWorkspaceName, sessionsDirFor, parseGroupLines, readTranscript, scanTranscripts, linesOf, speakerCounts } from '../src/features/session-history.js'

test('工作区路径编码成 DSH 会话目录名', () => {
  assert.equal(
    escapeWorkspaceName('/home/user/harness/Aurabot/qq-chats2'),
    '--home-user-harness-Aurabot-qq-chats2--',
  )
})

test('解析群聊发言：带序号/短横前缀、名字带括号也能切对', () => {
  const text = [
    '【群聊 示例群】之前在聊：',
    '-路人甲、(777888999)：今天怎么又炸了',
    '路人乙(888999111)：没炸，还能聊呢',
    '[3] 路人丙(999222333)：先重启，不行再看日志',
    '主人@了你：还活着吗',
    '小鸽子（路人丁）(123123123)：括号里的人名也要能切',
  ].join('\n')
  const out = parseGroupLines(text)
  assert.deepEqual(out.map((x) => x.uid), ['777888999', '888999111', '999222333', '123123123'])
  assert.equal(out[0].name, '路人甲、')
  assert.equal(out[2].text, '先重启，不行再看日志')
  assert.equal(out[0].group, '示例群')
  assert.equal(out[3].name, '小鸽子（路人丁）', '名字里的括号不能把 QQ 号切错')
})

test('没有 QQ 号的行（主人@了你）不当作群友发言', () => {
  const out = parseGroupLines('【群聊 测试群】\n主人@了你：在吗\n[1] 某人(123456)：在')
  assert.deepEqual(out.map((x) => x.uid), ['123456'])
})

test('群名过滤：只留这个群的发言', () => {
  const text = '【群聊 A群】\n甲(111111)：a\n【群聊 B群】\n乙(222222)：b'
  assert.deepEqual(parseGroupLines(text).filter((x) => x.group === 'B群').map((x) => x.uid), ['222222'])
})

test('readTranscript：认 zstd 也认明文 jsonl，坏文件不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'))
  const z = join(dir, 'a.zstd')
  writeFileSync(z, zstdCompressSync(Buffer.from('{"ok":1}')))
  assert.equal(readTranscript(z), '{"ok":1}')
  const plain = join(dir, 'b.jsonl')
  writeFileSync(plain, '{"plain":1}')
  assert.equal(readTranscript(plain), '{"plain":1}')
  const broken = join(dir, 'c.zstd')
  writeFileSync(broken, Buffer.from('not zstd at all'))
  assert.equal(readTranscript(broken), '', '坏了要静默返回空，不能毁掉整次扫描')
  rmSync(dir, { recursive: true, force: true })
})

test('scanTranscripts：端到端解压会话目录并统计发言人', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist2-'))
  const sess = join(dir, 'session-abc')
  mkdirSync(sess, { recursive: true })
  const events = [
    { type: 'session', id: 'session-abc' },
    { type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '【群聊 T】\n甲(111111)：第一句\n乙(222222)：嗯' }] } },
    { type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: '【群聊 T】\n甲(111111)：第二句\n甲(111111)：第三句' }] } },
  ].map((o) => JSON.stringify(o)).join('\n')
  writeFileSync(join(sess, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events)))
  const r = scanTranscripts(dir)
  assert.equal(r.sessions, 1)
  assert.equal(r.lines.length, 4)
  assert.equal(r.spans.from, 1000)
  assert.equal(r.spans.to, 2000)
  assert.deepEqual(speakerCounts(r.lines)[0], { uid: '111111', name: '甲', count: 3 })
  assert.equal(linesOf(r.lines, '222222').length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('sessionsDirFor：找不到返回空串，不抛', () => {
  assert.equal(sessionsDirFor('/definitely/not/here', { home: '/nope', dshHome: '/nope2' }), '')
})

test('接线：面板和路由都在，且真读了历史', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.match(mem, /scanTranscripts\(dir, \{ group: groupName \}\)/, 'memory 里扫历史（会话记录作补充源）')
  // #74：chatlog 是主证据源 —— 会话记录会把主人发言脱敏成「主人：…」（无 QQ 号），
  // 解析正则认不出来，所以主人学自己会永远卡在旧数据。chatlog 有真实 uid。
  assert.match(mem, /chatLogSnapshot\(day\)\?\.records/, 'chatlog 快照取 records 数组')
  assert.match(mem, /chatId\) !== `group:\$\{group\}`/, 'chatlog 按群 id 精确过滤')
  assert.match(mem, /learnDistillFromHistory/, '有「从历史学」入口')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/history'/)
  assert.match(mod, /api\.route\('\/distill\/from-history'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /翻一翻聊天历史/, '面板有扫描按钮')
  assert.match(client, /从历史学/, '每个目标有立刻学的按钮')
})

// 真实数据冒烟（有会话记录才跑，CI 上跳过；本机想跑就设 QQHUB_SMOKE_WORKSPACE / QQHUB_SMOKE_DSH_HOME）
test('真实会话目录能扫出东西（本机有才跑）', () => {
  const dir = sessionsDirFor(process.env.QQHUB_SMOKE_WORKSPACE || '/home/user/harness/Aurabot/qq-chats2', { dshHome: process.env.QQHUB_SMOKE_DSH_HOME || '/home/user/harness/.dsh' })
  if (!dir) return
  const r = scanTranscripts(dir)
  assert.ok(r.sessions > 0, '扫到会话')
  assert.ok(r.lines.length > 0, '扫到群聊发言')
})
