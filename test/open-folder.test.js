// T1.4 回归：openLocalFolder 跨平台「打开文件夹」。
//
// P0 现场：Linux/fnOS 上没有 explorer.exe，spawn 异步发出的 ENOENT 'error' 事件没人监听，
// 直接以未捕获异常打崩整个 DSH 宿主进程。这里真实调用导出函数并真实 emit('error')。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLocalFolder } from '../src/host/http.js'

function fakeSpawn() {
  const calls = []
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.unrefCalled = false
    child.unref = () => { child.unrefCalled = true }
    calls.push({ cmd, args, opts, child })
    return child
  }
  return { spawnFn, calls }
}

const workDir = () => join(mkdtempSync(join(tmpdir(), 'qqhub-open-')), 'nested', 'target')

test('T1.4 无桌面 Linux：不 spawn，直接回报目录路径且目录已建好', () => {
  const dir = workDir()
  const { spawnFn, calls } = fakeSpawn()
  const r = openLocalFolder(dir, { platform: 'linux', env: {}, spawnFn })
  assert.equal(calls.length, 0, '无 DISPLAY 时绝不能 spawn（会 ENOENT 崩进程）')
  assert.equal(r.ok, true)
  assert.equal(r.headless, true)
  assert.equal(r.dir, dir)
  assert.match(r.message, /无桌面 Linux 环境/)
  assert.ok(r.message.includes(dir), '提示里要给出目录路径')
  assert.equal(existsSync(dir), true, '目录必须建出来')
})

test('T1.4 有桌面 Linux / macOS / Windows 分别用 xdg-open / open / explorer.exe', () => {
  const dir = workDir()

  const linux = fakeSpawn()
  openLocalFolder(dir, { platform: 'linux', env: { DISPLAY: ':0' }, spawnFn: linux.spawnFn })
  assert.equal(linux.calls.length, 1)
  assert.equal(linux.calls[0].cmd, 'xdg-open')
  assert.deepEqual(linux.calls[0].args, [dir])
  assert.equal(linux.calls[0].opts.detached, true)
  assert.equal(linux.calls[0].child.unrefCalled, true)

  const wayland = fakeSpawn()
  openLocalFolder(dir, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, spawnFn: wayland.spawnFn })
  assert.equal(wayland.calls[0].cmd, 'xdg-open', 'Wayland 也算有桌面')

  const mac = fakeSpawn()
  openLocalFolder(dir, { platform: 'darwin', env: {}, spawnFn: mac.spawnFn })
  assert.equal(mac.calls[0].cmd, 'open')

  const win = fakeSpawn()
  openLocalFolder(dir, { platform: 'win32', env: {}, spawnFn: win.spawnFn })
  assert.equal(win.calls[0].cmd, 'explorer.exe')
})

test('T1.4 spawn 发出 ENOENT error 事件不崩进程，只记一条 warn', () => {
  const dir = workDir()
  const warns = []
  const { spawnFn, calls } = fakeSpawn()
  const r = openLocalFolder(dir, {
    platform: 'linux',
    env: { DISPLAY: ':0' },
    spawnFn,
    log: { warn: (...a) => warns.push(a.join(' ')) },
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)

  // 子进程不存在时 Node 会在下一个 tick 发 'error'；没有监听者就是未捕获异常。
  const err = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })
  assert.doesNotThrow(() => calls[0].child.emit('error', err), 'error 事件必须被接住')
  assert.equal(warns.length, 1)
  assert.match(warns[0], /ENOENT/)
  assert.ok(warns[0].includes(dir), 'warn 里要带目录路径方便人工兜底')
})

test('T1.4 spawn 同步抛错（权限不足等）也不崩，返回目录路径', () => {
  const dir = workDir()
  const warns = []
  const spawnFn = () => { throw new Error('EACCES') }
  const r = openLocalFolder(dir, {
    platform: 'linux',
    env: { DISPLAY: ':0' },
    spawnFn,
    log: { warn: (...a) => warns.push(a.join(' ')) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.dir, dir)
  assert.ok(r.message.includes(dir))
  assert.match(warns[0], /EACCES/)
})
