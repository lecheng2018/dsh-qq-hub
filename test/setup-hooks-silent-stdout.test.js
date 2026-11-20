import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// scripts/setup-hooks.mjs 由 package.json 的 `prepare` 调用，也就是每次 `npm install` / `npm ci` 都会跑。
// 它必须**只往 stderr 写**：npm 10（CI 的 node 22.13.0）会把 prepare 的 stdout 混进 `npm pack --json`
// 的机器可读输出，`scripts/smoke-pack.mjs` 里的 JSON.parse 会当场崩（2026-11-20 Verify 就是这么红的：
// `SyntaxError: Unexpected token 'g', "git hooks "... is not valid JSON`）。
//
// 这条测试守的就是「stdout 保持为空」，避免以后有人把提示改回 console.log。

const SCRIPT = join(process.cwd(), 'scripts', 'setup-hooks.mjs')

function runScript() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' })
}

test('prepare 脚本：stdout 必须为空，否则会污染 npm pack --json', () => {
  const result = runScript()
  assert.equal(result.status, 0, `setup-hooks 应正常退出，实际 stderr：${result.stderr}`)
  assert.equal(
    result.stdout,
    '',
    `setup-hooks 不得往 stdout 写东西（会污染 npm pack --json），实际输出：${JSON.stringify(result.stdout)}`,
  )
})

test('prepare 脚本：提示信息走 stderr，不静默吞掉', () => {
  const result = runScript()
  // 在 git 检出里应报「已指向」；在 tarball 里应报「跳过」。两者都必须是 stderr 且非空。
  assert.notEqual(result.stderr.trim(), '', '状态提示应写到 stderr，不能连诊断信息都没有')
})