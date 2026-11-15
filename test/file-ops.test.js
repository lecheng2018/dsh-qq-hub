// 工作区文件模块（workspace-files/）与群文件 upload 门控的回归网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeName, insideWorkspace, writeGate, MAX_WRITE_BYTES, READ_MAX_CHARS } from '../src/modules/workspace-files/index.js'
import { uploadGate } from '../src/modules/group-files/index.js'

// ---------------------------------------------------------------------------
// sanitizeName：只留文件名，剥路径分隔符
// ---------------------------------------------------------------------------

test('sanitizeName：剥路径分隔符与保留字符，空名给兜底', () => {
  assert.equal(sanitizeName('reply.txt'), 'reply.txt')
  assert.equal(sanitizeName('../../etc/passwd'), '_.._etc_passwd', '分隔符被替换 + 前导点剥掉（无穿越、无隐藏文件）')
  assert.equal(sanitizeName('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt')
  assert.equal(sanitizeName('  '), 'file.txt')
  assert.equal(sanitizeName(null), 'file.txt')
  assert.equal(sanitizeName('.hidden'), 'hidden', '开头点号剥掉（不留隐藏文件）')
  assert.equal(sanitizeName('长'.repeat(200)).length, 100)
})

// ---------------------------------------------------------------------------
// writeGate：主人私聊直接可用，群聊要有主人发言
// ---------------------------------------------------------------------------

test('writeGate：full 直接过；群聊有主人发言过；都没有拒绝', () => {
  assert.equal(writeGate({ level: 'full', ownerInTurn: false }).ok, true)
  assert.equal(writeGate({ level: 'social', ownerInTurn: true }).ok, true)
  assert.equal(writeGate({ level: 'social', ownerInTurn: false }).ok, false)
})

// ---------------------------------------------------------------------------
// insideWorkspace：防把工作区外的文件读进来
// ---------------------------------------------------------------------------

test('insideWorkspace：工作区内 true，穿越/外部 false，垃圾输入 false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-test-'))
  assert.equal(insideWorkspace(join(root, 'files', 'a.txt'), root), true)
  assert.equal(insideWorkspace(join(root, 'a.txt'), root), true)
  assert.equal(insideWorkspace(join(root, '..', 'outside.txt'), root), false)
  assert.equal(insideWorkspace('/etc/passwd', root), false)
  assert.equal(insideWorkspace('', root), false)
  assert.equal(insideWorkspace(null, root), false)
})

// ---------------------------------------------------------------------------
// 常量护栏
// ---------------------------------------------------------------------------

test('写上限 512KB / 读上限 6 万字（防灌盘的底线）', () => {
  assert.equal(MAX_WRITE_BYTES, 512 * 1024)
  assert.equal(READ_MAX_CHARS, 60000)
})

// ---------------------------------------------------------------------------
// uploadGate：往共享空间传东西的门
// ---------------------------------------------------------------------------

test('uploadGate：全过放行；面板开关 / 主人 / dryRun 逐项拦截', () => {
  assert.equal(uploadGate({ ownerInTurn: true, dryRun: false, filesEnabled: true }).ok, true)
  const off = uploadGate({ ownerInTurn: true, dryRun: false, filesEnabled: false })
  assert.equal(off.ok, false)
  assert.match(off.message, /发文件没打开/)
  const noOwner = uploadGate({ ownerInTurn: false, dryRun: false, filesEnabled: true })
  assert.equal(noOwner.ok, false)
  assert.match(noOwner.message, /只有主人/)
  const dry = uploadGate({ ownerInTurn: true, dryRun: true, filesEnabled: true })
  assert.equal(dry.ok, false)
  assert.match(dry.message, /试运行/)
})
