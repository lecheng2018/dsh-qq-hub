// 回归：模块支持声明 platforms / headless 平台门禁，在无头 Linux/NAS 上静默跳过（Issue #4）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlatformSupported } from '../src/core/modules.js'
import petDef from '../src/modules/pet/index.js'
import { detectInstall } from '../src/snowluma/manager.js'

test('isPlatformSupported：跨平台匹配正确', () => {
  const winOnly = { id: 'test-win', platforms: ['win32'] }
  const linuxOnly = { id: 'test-linux', platforms: ['linux'] }
  const anyPlatform = { id: 'test-any' }

  assert.equal(isPlatformSupported(winOnly, 'win32').ok, true)
  assert.equal(isPlatformSupported(winOnly, 'linux').ok, false)
  assert.match(isPlatformSupported(winOnly, 'linux').reason, /仅支持 win32 平台/)

  assert.equal(isPlatformSupported(linuxOnly, 'linux').ok, true)
  assert.equal(isPlatformSupported(linuxOnly, 'win32').ok, false)

  assert.equal(isPlatformSupported(anyPlatform, 'linux').ok, true)
  assert.equal(isPlatformSupported(anyPlatform, 'win32').ok, true)
  assert.equal(isPlatformSupported(anyPlatform, 'darwin').ok, true)
})

test('isPlatformSupported：headless 环境检测', () => {
  const guiModule = { id: 'gui-app', headless: false }

  // Windows 下默认当有桌面
  assert.equal(isPlatformSupported(guiModule, 'win32', {}).ok, true)

  // Linux 无 DISPLAY / WAYLAND_DISPLAY 下判定为无头
  const headlessEnv = {}
  const res = isPlatformSupported(guiModule, 'linux', headlessEnv)
  assert.equal(res.ok, false)
  assert.match(res.reason, /需要桌面图形（GUI）环境/)

  // Linux 有 DISPLAY 时判定通过
  const guiEnv = { DISPLAY: ':0' }
  assert.equal(isPlatformSupported(guiModule, 'linux', guiEnv).ok, true)
})

test('pet 模块已声明 platforms: win32 与 headless: false', () => {
  assert.deepEqual(petDef.platforms, ['win32'])
  assert.equal(petDef.headless, false)

  // 在当前 Linux 环境下自动判定为不受支持
  const check = isPlatformSupported(petDef, 'linux')
  assert.equal(check.ok, false)
})

test('SnowLuma 在非 Windows 环境下 detectInstall 给出清晰容器引导', () => {
  if (process.platform !== 'win32') {
    const res = detectInstall('C:\\Aurabot\\snowluma')
    assert.equal(res.installed, false)
    assert.match(res.reason, /非 Windows 环境.*建议使用 Docker/)
  }
})
