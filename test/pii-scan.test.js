// 守住 scripts/pii-scan.mjs 的判定口径 —— CI（.github/workflows/pii-scan.yml）与 pre-push 钩子
// 共用这一份规则；口径松一寸，真实群号就能再进一次公开历史（2026-11-23 全仓审计的起因）。
// 样例里的号码全是编的；HIGH 样例用拼接避开字面量，否则这个测试文件自己就会被扫描器拦下。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedLines, detectLine, isFakeNumber, loadAllowlist, mask, scanFile, selftest } from '../scripts/pii-scan.mjs'

const allow = loadAllowlist()
const REAL = '2865432109' // pii-scan:ignore 编造的样例号
const GHP = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'AAAA'

test('内置自检必须全绿（坏掉的扫描器会给出假的「干净」）', () => {
  assert.deepEqual(selftest(), [])
})

test('长数字：假数据形态放行，真实形态报出', () => {
  const fakes = ['10001', '333444555', '123456789', '321321321', '99998888', '10000001', '20000002', '1000000001', '20261123', '1763000000', '86400000', '1048576', '2147483647']
  for (const ok of fakes) assert.equal(isFakeNumber(ok), true, `应放行：${ok}`)
  for (const bad of [REAL, '1987654321', '8801234566']) assert.equal(isFakeNumber(bad), false, `应报出：${bad}`) // pii-scan:ignore 编造的样例号
})

test('HIGH 不接受 pii-scan:ignore 豁免，MEDIUM 接受', () => {
  assert.deepEqual(detectLine(`token = "${GHP}" /* pii-scan:ignore */`, { allow }).map(f => f.sev), ['HIGH'])
  assert.deepEqual(detectLine(`chatId: 'group:${REAL}'`, { allow }).map(f => f.id), ['long-number'])
  assert.deepEqual(detectLine(`chatId: 'group:${REAL}' /* pii-scan:ignore */`, { allow }), [])
})

test('路径子串里的 sk- 不算 key；教程式假账号密码与 CI 模板凭据不算泄漏', () => {
  assert.deepEqual(detectLine("'.mimosa/reports/task-review-sess_2c268665-781f-4875-a31c-bb72899b71e6.json'", { allow }), [])
  assert.deepEqual(detectLine("check('https://user:pw@www.douyin.com/')", { allow }), [])
  assert.deepEqual(detectLine('git push https://x-access-token:${GITHUB_TOKEN}@github.com/acme/widgets.git', { allow }), [])
})

test('allowlist 只豁免字面量本身，不放宽规则', () => {
  assert.deepEqual(detectLine('http://192.168.10.1:7890', { allow }), [])
  assert.deepEqual(detectLine("host: '192.168.1.9'", { allow }).map(f => f.id), ['lan-ip']) // pii-scan:ignore 编造的样例
})

test('输出打码：不得原样回显', () => {
  for (const f of detectLine(`ownerQQ: '${REAL}'`, { allow })) assert.equal(f.value.includes(REAL), false)
  for (const f of detectLine(`token = "${GHP}"`, { allow })) assert.equal(f.value.includes(GHP.slice(4)), false)
  assert.equal(mask('12345'), '1***')
})

test('diff 解析：只取新增行，行号按 + 侧', () => {
  const diff = [
    '+++ b/a.js', '@@ -3,0 +4,2 @@', '+one', '+two',
    '--- a/x.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
    '+++ b/b.js', '@@ -1 +1 @@', '-x', '+y'
  ].join('\n')
  assert.deepEqual([...addedLines(diff)], [
    { path: 'a.js', line: 4, text: 'one' },
    { path: 'a.js', line: 5, text: 'two' },
    { path: 'b.js', line: 1, text: 'y' }
  ])
})

test('scanFile 对仓库外的绝对路径也必须真扫（CLI scan 模式曾经静默放行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-scan-'))
  try {
    const file = join(dir, 'leak.js')
    writeFileSync(file, `const owner = '${REAL}'\n`)
    const got = scanFile(file, allow)
    assert.deepEqual(got.map(f => f.id), ['long-number'])
    assert.equal(got[0].value.includes(REAL), false, '输出必须打码')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
