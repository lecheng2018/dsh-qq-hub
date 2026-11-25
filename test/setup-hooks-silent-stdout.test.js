import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// scripts/setup-hooks.mjs 由开发者显式通过 `npm run setup:hooks` 调用。
// 1. 它必须**只往 stderr 写**，避免未来被管道或机器可读命令复用时污染 stdout。
// 2. package.json 禁止声明 `prepare` / `preinstall` / `install` / `postinstall`
//    安装期构建脚本：DSH 插件市场底层用 pnpm 安装 Git 依赖时会拦截 `prepare`，
//    导致用户首次安装与每次更新都被迫手动放行构建脚本（面板产物 client/client.js
//    已随仓提交，终端用户安装不需要跑任何构建脚本）。

const SCRIPT = join(process.cwd(), 'scripts', 'setup-hooks.mjs')
const PKG_PATH = join(process.cwd(), 'package.json')

function runScript() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' })
}

test('setup-hooks 脚本：stdout 必须为空', () => {
  const result = runScript()
  assert.equal(result.status, 0, `setup-hooks 应正常退出，实际 stderr：${result.stderr}`)
  assert.equal(
    result.stdout,
    '',
    `setup-hooks 不得往 stdout 写东西，实际输出：${JSON.stringify(result.stdout)}`,
  )
})

test('setup-hooks 脚本：提示信息走 stderr，不静默吞掉', () => {
  const result = runScript()
  // 在 git 检出里应报「已指向」；在 tarball 里应报「跳过」。两者都必须是 stderr 且非空。
  assert.notEqual(result.stderr.trim(), '', '状态提示应写到 stderr，不能连诊断信息都没有')
})

test('package.json 不声明安装期生命周期脚本，避免 pnpm 拦截插件市场一键安装', () => {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  const scripts = pkg.scripts || {}
  for (const hook of ['prepare', 'preinstall', 'install', 'postinstall']) {
    assert.equal(
      scripts[hook],
      undefined,
      `package.json.scripts 不应包含 ${hook}（会触发 pnpm 构建脚本拦截）：${JSON.stringify(scripts[hook])}`,
    )
  }
  assert.equal(scripts['setup:hooks'], 'node scripts/setup-hooks.mjs')
})
