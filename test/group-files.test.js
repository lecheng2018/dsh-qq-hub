// 群文件模块（group-files/）的回归网：整形/抽取防御式 + manage 三重门。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  humanSize, normalizeFileEntry, extractEntries,
  formatDirListing, formatSystemInfo, manageGate,
} from '../src/modules/group-files/index.js'

test('normalizeFileEntry：snake / camel / folder 三种形状都能整', () => {
  assert.deepEqual(normalizeFileEntry({ file_id: 'f1', file_name: 'a.zip', file_size: 10 }), { id: 'f1', name: 'a.zip', size: 10, busid: 0, isDir: false, folderId: '' })
  assert.equal(normalizeFileEntry({ file_id: 'f2', file_name: 'b.zip', busid: 77 }).busid, 77, 'busid 原值保留（下载要用）')
  const dir = normalizeFileEntry({ id: 'd1', name: '相册', is_dir: true })
  assert.equal(dir.isDir, true)
  assert.equal(dir.folderId, 'd1')
  assert.equal(normalizeFileEntry(null).name, '（未命名）', '垃圾条目给占位名，绝不丢')
})

test('extractEntries：数组 / {files} / {data:{files}} 都认；认不出返回空', () => {
  const entry = { file_id: 'f1', file_name: 'a.zip' }
  for (const shape of [[entry], { files: [entry] }, { data: { files: [entry] } }]) {
    assert.equal(extractEntries(shape).length, 1)
  }
  assert.deepEqual(extractEntries(undefined), [])
  assert.deepEqual(extractEntries({ files: 'x' }), [])
})

test('formatDirListing：目录在前、带 id、超量提示；空目录明说', () => {
  const text = formatDirListing([
    { id: 'd1', name: '相册', isDir: true, folderId: 'd1' },
    { id: 'f1', name: 'a.zip', size: 2048 },
    { id: 'f2', name: 'b.png' },
  ], { limit: 2 })
  assert.match(text, /📁 相册  \[目录 id=d1\]/)
  assert.match(text, /a\.zip（2KB）  \[文件 id=f1\]/)
  assert.match(text, /共 3 项/)
  assert.equal(formatDirListing([]), '（这个目录是空的）')
})

test('formatSystemInfo：拿得到就给摘要，拿不到返回空串', () => {
  assert.match(formatSystemInfo({ total: 10 * 1024 * 1024 * 1024, used: 5 * 1024 * 1024 }), /已用 5\.0MB \/ 共 10\.00GB/)
  assert.equal(formatSystemInfo({}), '')
  assert.equal(formatSystemInfo(null), '')
})

// ---------------------------------------------------------------------------
// manageGate：改共享空间的动作，三重门缺一不可
// ---------------------------------------------------------------------------

test('manageGate：三重门全过才放行', () => {
  const pass = manageGate({ ownerInTurn: true, confirm: '确认', dryRun: false, allowManage: true })
  assert.equal(pass.ok, true)
})

test('manageGate：面板开关默认关，最先挡住', () => {
  const r = manageGate({ ownerInTurn: true, confirm: '确认', dryRun: false, allowManage: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /面板「群文件」页/)
})

test('manageGate：这一轮没有主人发言，谁都不行', () => {
  const r = manageGate({ ownerInTurn: false, confirm: '确认', dryRun: false, allowManage: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /只有主人/)
})

test('manageGate：confirm 不是「确认」就拒绝（防顺手触发）', () => {
  for (const bad of [undefined, '', '确认删除', 'yes', '确认吗']) {
    const r = manageGate({ ownerInTurn: true, confirm: bad, dryRun: false, allowManage: true })
    assert.equal(r.ok, false, `confirm=${JSON.stringify(bad)} 必须拒绝`)
  }
})

test('manageGate：试运行放行但标记 dryRun（不动群文件）', () => {
  const r = manageGate({ ownerInTurn: true, confirm: '确认', dryRun: true, allowManage: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
})
