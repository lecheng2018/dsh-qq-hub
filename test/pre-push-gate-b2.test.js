// Batch 2 / T2.9：pre-push 门禁失效（stdin 被第一个循环读干）与 deploy 脚本注入。
// 用例真实执行钩子脚本：喂模拟 ref 行，观察第二道门禁是否真的读到了范围。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout.trim()
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'b2-prepush-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(join(dir, '.githooks'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  cpSync(join(root, '.githooks/pre-push'), join(dir, '.githooks/pre-push'))
  cpSync(join(root, 'scripts/pii-scan.mjs'), join(dir, 'scripts/pii-scan.mjs'))
  cpSync(join(root, 'scripts/check-numbers.mjs'), join(dir, 'scripts/check-numbers.mjs'))
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  // 只触发「裸号码」门禁、不触发 PII 扫描的夹具：用来区分「第二道门禁到底读没读到 ref」
  mkdirSync(join(dir, 'probe'), { recursive: true })
  writeFileSync(join(dir, 'probe/bad.json'), '{"chatId": "group:12345678"}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'probe numeric fixture')
  return dir
}

function runHook(dir, stdinLines, extraEnv = {}) {
  return spawnSync('bash', ['.githooks/pre-push'], {
    cwd: dir,
    input: stdinLines,
    encoding: 'utf8',
    env: { ...process.env, PII_SKIP_SELFTEST: '1', ...extraEnv },
  })
}

test('T2.9：pre-push 第二道门禁（裸号码）能读到 ref 行并拦下', () => {
  const dir = makeRepo()
  try {
    const head = git(dir, 'rev-parse', 'HEAD')
    const base = git(dir, 'rev-parse', 'HEAD~1')
    // 旧实现：第一道门禁的 while 循环把 stdin 读干，第二道循环执行 0 次 → 静默放过
    const r = runHook(dir, `refs/heads/probe ${head} refs/heads/probe ${base}\n`)
    assert.equal(r.status, 1, `pre-push 应该拦下，实际退出码 ${r.status}\n${r.stderr}`)
    assert.match(r.stderr, /QQ 号 \/ 群号形状的数字/, '必须报出裸号码门禁')
    // 第一道门禁确实跑过（证明 stdin 被读过一次，后面的门禁仍然拿得到 ref）
    assert.match(r.stderr, /PII|扫描器/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('T2.9：pre-push 删除分支的 ref 不会被当成待扫描内容', () => {
  const dir = makeRepo()
  try {
    const r = runHook(dir, 'refs/heads/x 0000000000000000000000000000000000000000 refs/heads/x 1111111111111111111111111111111111111111\n')
    assert.equal(r.status, 0, `删除远端分支应放行，实际 ${r.status}\n${r.stderr}`)
    assert.doesNotMatch(r.stderr, /QQ 号 \/ 群号形状的数字/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('T2.9：deploy-package.sh 语法合法，且版本读取不再拼进 -p 脚本正文', () => {
  const script = join(root, 'scripts/deploy-package.sh')
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  // 目录名里塞一段 JS：旧写法 `require('$SRC_ROOT/package.json')` 会把它当代码执行
  const dir = mkdtempSync(join(tmpdir(), 'b2-deploy-'))
  const marker = join(dir, 'pwned.txt')
  const evil = join(dir, `x');require('node:fs').writeFileSync(${JSON.stringify(marker)},'1');//`)
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(evil, 'package.json'), '{"version":"9.9.9"}\n')
  try {
    // 新写法（脚本里实际使用的形式）
    const ok = spawnSync('node', ['-p', 'require(process.argv[1]).version', join(evil, 'package.json')], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stdout.trim(), '9.9.9')
    assert.equal(existsSync(marker), false, '路径绝不能被当成 JS 执行')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
