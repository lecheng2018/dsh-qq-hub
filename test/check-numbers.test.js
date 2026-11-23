// 上传门禁：QQ 号 / 群号的「形状」检查。
//
// 为什么需要它（2026-11-23 事故）：pii-guard 的 qq-number 规则要求上下文关键词，
// 于是 `"chatId": "group:<群号>"`、`真机：<群号>` 这些写法全被放过，
// 真实群号和主人 QQ 直接进了 public 仓库。这个脚本不看关键词，只看形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/check-numbers.mjs')

// 样例号码在运行时拼出来：测试要的是「9/10 位数字的形状」，源码里不留长数字字面量
// （否则仓库自己的裸号码门禁会对着这个测试文件报，还得逐行加豁免）。
const GROUP = ['955741', '999'].join('')
const OTHER = ['995845', '999'].join('')
const OWNER = ['2471780', '123'].join('')
const FAKE = ['123456', '789'].join('')
const REPEAT = '9'.repeat(9)

function run (...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

function withFile (content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-num-'))
  const file = join(dir, 'probe.txt')
  writeFileSync(file, content)
  try { return fn(file) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('抓得到：group: / private: 这种没有关键词的写法', () => {
  withFile(`x\n"chatId": "group:${GROUP}"\n`, (f) => {
    const r = run('--file', f)
    assert.equal(r.code, 1, '要拦下')
    assert.match(r.out, /可疑/)
    assert.ok(!r.out.includes(GROUP), '输出里只能出现打码后的号码')
  })
  withFile(`fixture: 'private:${OWNER}'\n`, (f) => {
    assert.equal(run('--file', f).code, 1, '主人 QQ 的 fixture 也要拦')
  })
})

test('放过：日期、短数字、标识符、全同数字、行内豁免', () => {
  withFile([
    '版本 1.4.9-test.20261123.2',   // YYYYMMDD 日期
    'contextWindow: 1048576',       // 7 位，不在 8–12 范围
    'sha eca52fe2 与 1234567890abcdef', // 紧邻字母 = 标识符
    `号码 ${REPEAT}`,                // 全同
    `假数据 ${FAKE}  # pii-scan:ignore` // 显式豁免
  ].join('\n'), (f) => {
    const r = run('--file', f)
    assert.equal(r.code, 0, `不该拦：${r.out}`)
    assert.match(r.out, /没发现/)
  })
})

test('--range：只看新增行（删掉的旧号码不算新泄漏）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-num-git-'))
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), `第一版 ${GROUP}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD').stdout.trim()
    // 这一版把号码换成占位：新增行里没有号码，不该拦
    writeFileSync(join(dir, 'a.txt'), '第一版 <群号>\n')
    git('add', '.')
    git('commit', '-q', '-m', 'redact')
    const head = git('rev-parse', 'HEAD').stdout.trim()
    const r = spawnSync(process.execPath, [SCRIPT, '--range', `${base}..${head}`], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, `删掉旧号码不该拦：${r.stdout}${r.stderr}`)
    // 再加一个号码：要拦
    writeFileSync(join(dir, 'a.txt'), `第一版 <群号>\n又见 ${OTHER}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'leak')
    const head2 = git('rev-parse', 'HEAD').stdout.trim()
    const r2 = spawnSync(process.execPath, [SCRIPT, '--range', `${head}..${head2}`], { cwd: dir, encoding: 'utf8' })
    assert.equal(r2.status, 1, '新增号码必须拦下')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pre-push 钩子里确实接了这道门禁', async () => {
  const { readFileSync } = await import('node:fs')
  const hook = readFileSync(join(ROOT, '.githooks/pre-push'), 'utf8')
  assert.match(hook, /check-numbers\.mjs --range/, '钩子要按待推送范围跑形状检查')
  assert.match(hook, /PII_SKIP_NUMBERS/, '要留显式跳过开关（和 PII_SKIP_SELFTEST 一致口径）')
})
