// 用户态安装器：纯函数部分（不真的下包）。
// 真机安装另有一份手验脚本，普通测试不许因为「没网」变红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDepends, isElf, libDirsUnder, findBrowserElf, verifyInstalled, hasCommand,
} from '../src/browser/install.js'
import { findChrome } from '../src/browser/process.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'qqhub-install-'))

test('依赖解析：去掉版本约束、取 | 的第一个、忽略变量占位', () => {
  const deps = parseDepends('libasound2 (>= 1.0.17), libatk-bridge2.0-0 (>= 2.5.3), ${misc:Depends}, foo | bar, xdg-utils')
  assert.deepEqual(deps, ['libasound2', 'libatk-bridge2.0-0', 'foo', 'xdg-utils'])
})

test('依赖解析：空值和脏数据不炸', () => {
  assert.deepEqual(parseDepends(''), [])
  assert.deepEqual(parseDepends(null), [])
  assert.deepEqual(parseDepends('  ,,  '), [])
})

test('isElf：真 ELF 认得，壳脚本不认', () => {
  const dir = tmp()
  try {
    const script = join(dir, 'chromium')
    writeFileSync(script, '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n')
    assert.equal(isElf(script), false, '壳脚本不是 ELF —— 这正是 ldd 看不出问题的原因')
    assert.equal(isElf(join(dir, 'nope')), false)
    // 系统里现成的 ELF
    assert.equal(isElf('/bin/sh'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findBrowserElf：跳过壳脚本，挑到真二进制', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'usr', 'bin'), { recursive: true })
    mkdirSync(join(dir, 'usr', 'lib', 'chromium'), { recursive: true })
    // 壳脚本 /usr/bin/chromium
    writeFileSync(join(dir, 'usr', 'bin', 'chromium'), '#!/bin/sh\nexec ../lib/chromium/chromium "$@"\n')
    chmodSync(join(dir, 'usr', 'bin', 'chromium'), 0o755)
    // 真二进制：拷一份 /bin/sh 当替身（它确实是 ELF）
    const real = join(dir, 'usr', 'lib', 'chromium', 'chromium')
    writeFileSync(real, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
    const found = findBrowserElf(dir)
    assert.equal(found, real, '应当选 /usr/lib/chromium/chromium 而不是 /usr/bin/chromium')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findBrowserElf：只有壳脚本时要返回空（免得拿脚本去启动）', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'usr', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'usr', 'bin', 'chromium'), '#!/bin/sh\n')
    assert.equal(findBrowserElf(dir), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('libDirsUnder：把解包出来的库目录都收进来', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'chromium', 'usr', 'lib', 'x86_64-linux-gnu'), { recursive: true })
    mkdirSync(join(dir, 'libopenh264', 'usr', 'lib', 'x86_64-linux-gnu'), { recursive: true })
    const dirs = libDirsUnder(dir)
    assert.ok(dirs.some((d) => d.includes('chromium')))
    assert.ok(dirs.some((d) => d.includes('libopenh264')))
    assert.equal(libDirsUnder(join(dir, 'nope')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyInstalled：没 manifest 就是没装', () => {
  const dir = tmp()
  try {
    const r = verifyInstalled(dir)
    assert.equal(r.ok, false)
    assert.match(r.reason, /还没装/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyInstalled：manifest 指向的二进制没了也算没装', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ browser: join(dir, 'gone'), libDirs: [] }))
    const r = verifyInstalled(dir)
    assert.equal(r.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findChrome：安装器的 manifest 优先于系统候选', () => {
  const dir = tmp()
  try {
    const elf = join(dir, 'my-chrome')
    writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ browser: elf }))
    assert.equal(findChrome('', dir), elf)
    // 面板显式填的仍然最优先
    assert.equal(findChrome('/usr/bin/whatever', dir, () => true), '/usr/bin/whatever')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('环境检查：这台机器有 apt-get / dpkg-deb / ldd 才谈得上安装', () => {
  // 不在 Debian 上跑就跳过，不要误红
  if (process.platform !== 'linux') return
  assert.ok(hasCommand('sh'))
})