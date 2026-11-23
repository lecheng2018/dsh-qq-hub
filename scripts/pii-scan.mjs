#!/usr/bin/env node
// scripts/pii-scan.mjs —— 仓库自带的 PII / 密钥扫描器（零依赖，Node ≥ 22）。
//
// 为什么要有它（2026-11-23）：全仓审计发现注释、CHANGELOG、测试夹具里写死了十几个真实
// QQ 群号 / QQ 号（含主人号与机器人号），在公开历史里躺了三周才被发现。本地 pre-push 钩子
// 原本只认 NAS 上的一份 pii_scan.py，开发机上找不到就「跳过」—— 门禁在最常写代码的机器上
// 从来没跑过。这里把扫描器收进仓库：
//   · CI（.github/workflows/pii-scan.yml）对每个 PR 的整棵树 + 新增行 + 提交信息跑一遍；
//   · pre-push 钩子找不到外部扫描器时回落到这里（同一份规则，本机与 CI 不再有缝隙）。
//
// 用法：
//   node scripts/pii-scan.mjs                   扫全树（已跟踪文件的工作区内容），默认
//   node scripts/pii-scan.mjs --tree            同上
//   node scripts/pii-scan.mjs git --range A..B  A..B 的新增行 + 该区间提交信息 + 工作区改动 + 未跟踪文件
//   node scripts/pii-scan.mjs scan <file>...    只扫指定文件
//   node scripts/pii-scan.mjs selftest          内置样例自检（坏掉的扫描器会给出假的「干净」）
//
// 规则分级（与 .githooks/pre-push 的约定一致）：
//   HIGH   凭据形态（token / key / 私钥 / 长 cookie / URL 内嵌账号密码）。不允许行内豁免。
//   MEDIUM 疑似真实标识（长数字/QQ 号、手机号、身份证、个人邮箱、私网 IP、疑似硬编码密钥）。
//          行内写 `pii-scan:ignore` 可豁免 —— 仅限确认为假数据的行。
//
// 假数据判定不靠「信任测试目录」，而靠号码本身的形态：位数 ≤6、重复/递增块、取整时间戳、
// 日期型版本号、仓库约定的占位区段（10000001 / 20000002 / 1000000001…）。其余一律报出来。
// 确实是假数据但形态不像的，写进根目录 .pii-allowlist（一行一个字面量），不要放宽规则。
//
// 退出码：存在未豁免的发现 → 1。输出里的值一律打码，免得 CI 日志本身变成新的泄漏面。

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
export const IGNORE_MARK = 'pii-scan:ignore'
const ALLOW_FILE = join(ROOT, '.pii-allowlist')
const MAX_BYTES = 2 * 1024 * 1024
// lock 文件里的 integrity 哈希是 base64，长得像密钥但不是；也不该手改
const SKIP_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|[^/]+\.lock)$/
const EMPTY_ALLOW = new Set()

// ── 假数据判定 ───────────────────────────────────────────────────────────────

/** 整串数字严格递增/递减 1：123456789、987654321。 */
export function isMonotonicRun (s) {
  const d = [...s].map(Number)
  const step = d[1] - d[0]
  if (step !== 1 && step !== -1) return false
  return d.every((v, i) => i < 2 || v - d[i - 1] === step)
}

/** 等长块、块内同字、块首递增/递减或全部相同：333444555、111222333、99998888。 */
export function isConsecutiveBlocks (s) {
  for (const size of [2, 3, 4]) {
    if (s.length % size) continue
    const blocks = []
    for (let i = 0; i < s.length; i += size) blocks.push(s.slice(i, i + size))
    if (blocks.some(b => !/^(\d)\1*$/.test(b))) continue
    const heads = blocks.map(b => Number(b[0]))
    if (heads.every(h => h === heads[0])) return true
    if (heads.every((h, i) => i === 0 || h === heads[i - 1] + 1)) return true
    if (heads.every((h, i) => i === 0 || h === heads[i - 1] - 1)) return true
  }
  return false
}

// 2 的幂及其 ±1 邻居（1048576 / 2147483647 / 4294967296…）、50 MiB：代码里最常见的非标识长数字
const POWER_CONSTANTS = new Set(['52428800'])
for (let k = 10; k <= 32; k++) {
  POWER_CONSTANTS.add(String(2 ** k))
  POWER_CONSTANTS.add(String(2 ** k + 1))
  POWER_CONSTANTS.add(String(2 ** k - 1))
}

/** 号码形态像假数据：位数短、重复/递增、占位区段、取整时间戳、日期型版本号。 */
export function isFakeNumber (s) {
  if (s.length <= 6) return true
  if (/^(\d)\1+$/.test(s)) return true
  if (/^[1-9]0{5,9}\d{0,2}$/.test(s)) return true
  if (/0{6,}$/.test(s)) return true
  // 末尾 ≥4 个零：86400000（一天的毫秒）、2500000（字节上限）这类取整常量。
  // 代价是末尾四个零的真实 QQ 号（万分之一）放行 —— 可接受，数量级远小于常量的误报量。
  if (/(?<=\d)0{4,}$/.test(s)) return true
  if (POWER_CONSTANTS.has(s)) return true
  if (/^(\d{2,5})\1+$/.test(s)) return true // 321321321：整块重复
  if (/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)) return true
  if (/^1234567890$|^0987654321$/.test(s)) return true
  return isMonotonicRun(s) || isConsecutiveBlocks(s)
}

/** 疑似硬编码密钥的值是不是明显的假值。 */
export function isFakeSecret (v) {
  return /^(.)\1*$/.test(v) || /(test|fake|dummy|example|mock|placeholder|sample|your|xxx|secret|password|changeme|\$\{|%\{|<[^>]+>)/i.test(v)
}

/** URL 里的 user:pass 是不是教程式的假账号。 */
export function isFakeCredentialPair (url) {
  const m = url.match(/^https?:\/\/([^:/\s@"'<>]+):([^@/\s@"'<>]+)@/)
  if (!m) return false
  const users = new Set(['user', 'username', 'test', 'foo', 'bar', 'admin', 'proxy'])
  const passes = new Set(['pw', 'pass', 'password', 'test', 'secret', '123456', 'xxx', 'proxy'])
  return users.has(m[1].toLowerCase()) && passes.has(m[2].toLowerCase())
}

/** 打码：保留头 3 尾 2，中间折叠。日志里不出现完整值。 */
export function mask (v) {
  if (v.length <= 6) return v.slice(0, 1) + '***'
  return v.slice(0, 3) + '*'.repeat(Math.min(v.length - 5, 12)) + v.slice(-2)
}

// ── 规则表 ───────────────────────────────────────────────────────────────────
// skip(match, allow) 返回 true 表示放行。正则都带 g：detectLine 用 matchAll 取全部命中。
const RULES = [
  // ── HIGH：凭据形态。不允许行内豁免 ──
  { id: 'github-token', sev: 'HIGH', msg: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'aws-access-key', sev: 'HIGH', msg: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // 前面不能紧贴字母/数字/_/-：否则 task-review-sess_2c26… 这类路径子串会误报
  { id: 'api-key', sev: 'HIGH', msg: 'API key（sk- 开头）', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g },
  { id: 'google-api-key', sev: 'HIGH', msg: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'jwt', sev: 'HIGH', msg: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'telegram-bot-token', sev: 'HIGH', msg: 'Telegram bot token', re: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { id: 'private-key', sev: 'HIGH', msg: '私钥', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // 20 字符起步：测试里的 BDUSS=test-secret / BDUSS=manual-cookie 都在阈值之下
  { id: 'cookie', sev: 'HIGH', msg: '登录 cookie 值', re: /\b(?:BDUSS|SESSDATA|bili_jct|PSTM|STOKEN)=[A-Za-z0-9%*_~-]{20,}/g },
  { id: 'bearer', sev: 'HIGH', msg: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
  // CI 里 x-access-token:${GITHUB_TOKEN}@github.com 是模板，不是泄漏：密码段含变量引用就放行
  {
    id: 'url-credentials', sev: 'HIGH', msg: 'URL 内嵌账号密码',
    re: /\bhttps?:\/\/[^\s/:@"'<>]+:[^\s/@"'<>]+@/g,
    skip: m => isFakeCredentialPair(m[0]) || /:(?:\$\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)@/.test(m[0])
  },

  // ── MEDIUM：疑似真实标识。行内 pii-scan:ignore 可豁免 ──
  // 7~11 位、前后不贴数字/字母/./- 的整数：QQ 号与群号最常见的形态。
  // 13 位毫秒时间戳因为「后面还有数字」天然不匹配；10 位取整时间戳与日期型版本号在 isFakeNumber 里放行。
  // 手机号交给 cn-id 之外的 cn-phone 规则单独报，这里不重复。
  {
    id: 'long-number', sev: 'MEDIUM', msg: '疑似真实 QQ 号/群号（长数字）',
    re: /(?<![0-9A-Za-z_.-])[1-9][0-9]{6,10}(?![0-9A-Za-z_.-])/g,
    skip: (m, allow) => isFakeNumber(m[0]) || /^1[3-9][0-9]{9}$/.test(m[0]) || allow.has(m[0])
  },
  { id: 'cn-phone', sev: 'MEDIUM', msg: '疑似手机号', re: /(?<![0-9A-Za-z_.-])1[3-9][0-9]{9}(?![0-9A-Za-z_.-])/g, skip: (m, allow) => allow.has(m[0]) },
  { id: 'cn-id', sev: 'MEDIUM', msg: '疑似身份证号', re: /(?<![0-9A-Za-z])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])/g },
  {
    id: 'email', sev: 'MEDIUM', msg: '个人邮箱',
    re: /\b[A-Za-z0-9._%+-]+@(?:qq|gmail|163|126|outlook|hotmail|foxmail|icloud|sina)\.com\b/g,
    skip: m => /(?:^|[^a-z])(example|noreply|no-reply|test|foo|bar|dummy|placeholder|someone)(?:[^a-z]|$)/i.test(m[0])
  },
  { id: 'lan-ip', sev: 'MEDIUM', msg: '私网 IP', re: /(?<![0-9.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![0-9.])/g, skip: (m, allow) => allow.has(m[0]) },
  // 16 字符起步 + 值里没有任何假数据字样，才当作疑似硬编码密钥
  {
    id: 'generic-secret', sev: 'MEDIUM', msg: '疑似硬编码密钥',
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*[:=]\s*["']([^"']{16,})["']/gi,
    skip: m => isFakeSecret(m[1])
  }
]

/** 单行检测。allow 是 .pii-allowlist 的字面量集合。 */
export function detectLine (text, { allow = EMPTY_ALLOW } = {}) {
  const out = []
  const ignorable = text.includes(IGNORE_MARK)
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = (m[1] ?? m[0]).trim()
      if (rule.skip && rule.skip(m, allow)) continue
      if (ignorable && rule.sev !== 'HIGH') continue
      out.push({ sev: rule.sev, id: rule.id, msg: rule.msg, value: mask(value) })
    }
  }
  return out
}

/** 整段文本检测，带行号。path 只用于回显。 */
export function scanText (text, { path, allow = EMPTY_ALLOW } = {}) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const f of detectLine(lines[i], { allow })) out.push({ path, line: i + 1, ...f })
  }
  return out
}

/** 读根目录 .pii-allowlist：一行一个字面量，# 之后是注释。 */
export function loadAllowlist (file = ALLOW_FILE) {
  const set = new Set()
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return set }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line) set.add(line)
  }
  return set
}

/** 解析 `git diff -U0` 输出，只产出新增行（含 + 侧行号）。 */
export function* addedLines (diff) {
  let path = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.includes('/dev/null') ? null : raw.slice(6)
      continue
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/)
      line = m ? Number(m[1]) - 1 : 0
      continue
    }
    if (!path) continue
    if (raw.startsWith('+')) {
      line++
      yield { path, line, text: raw.slice(1) }
    } else if (raw.startsWith(' ')) {
      line++
    }
  }
}

// ── 文件读取 ─────────────────────────────────────────────────────────────────
function readTextFile (file) {
  let st
  try { st = statSync(file) } catch { return null }
  if (!st.isFile() || st.size > MAX_BYTES) return null
  let buf
  try { buf = readFileSync(file) } catch { return null }
  // 前 8KB 里有 NUL 就当二进制：图片、字体、可执行文件都不是扫描对象
  if (buf.subarray(0, 8192).includes(0)) return null
  return buf.toString('utf8')
}

function git (args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
  })
}

function trackedFiles () {
  return git(['ls-files', '-z']).split('\0').filter(Boolean)
}

// target 可以是仓库相对路径，也可以是绝对路径（scan 模式）。读不到一律返回空数组 ——
// 对「文件不存在」返回空是对的，但绝不能把绝对路径拼到 ROOT 后面变成不存在的路径再静默放行。
export function scanFile (target, allow) {
  const abs = isAbsolute(target) ? target : join(ROOT, target)
  const rel = abs.startsWith(ROOT) ? abs.slice(ROOT.length + 1).replace(/\\/g, '/') : target
  if (SKIP_FILES.test(rel)) return []
  const text = readTextFile(abs)
  return text == null ? [] : scanText(text, { path: rel, allow })
}

// ── 三种扫描范围 ─────────────────────────────────────────────────────────────
function scanTree (allow) {
  return trackedFiles().flatMap(rel => scanFile(rel, allow))
}

function scanFiles (files, allow) {
  return files.flatMap(f => scanFile(resolve(f), allow))
}

function scanRange (range, allow) {
  const findings = []
  const diffOf = args => {
    try { return git(['diff', '-U0', '--no-color', '--diff-filter=AMR', ...args]) } catch { return '' }
  }
  const collect = (diff) => {
    for (const { path, line, text } of addedLines(diff)) {
      for (const f of detectLine(text, { allow })) findings.push({ path, line, ...f })
    }
  }
  // 1) 区间内提交新增的行
  collect(diffOf([range]))
  // 2) 区间内的提交信息 —— 历史上有 5 条提交信息正文里直接贴了真机日志
  try {
    for (const chunk of git(['log', '--format=%x00%H%x00%B%x01', range]).split('\x01')) {
      if (!chunk.trim()) continue
      const [, sha, body] = chunk.split('\x00')
      findings.push(...scanText(body || '', { path: `commit ${String(sha).slice(0, 7)}`, allow }))
    }
  } catch { /* 单提交仓库等算不出区间时，diff 已经报过错；这里不重复 */ }
  // 3) 工作区：已跟踪文件的改动 + 未被 ignore 的新文件 —— git add -A 会把它们一起带走
  collect(diffOf(['HEAD', '--']))
  return findings.concat(git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).flatMap(rel => scanFile(rel, allow)))
}

function report (findings) {
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  for (const f of findings) console.log(`${f.path}:${f.line}: [${f.sev}] ${f.id} — ${f.msg}：${f.value}`)
  const high = findings.filter(f => f.sev === 'HIGH').length
  console.log(`PII 扫描：${findings.length} 处（HIGH ${high}，MEDIUM ${findings.length - high}）`)
  if (findings.length) {
    console.log('  · MEDIUM 若确认是假数据：在该行末尾加 pii-scan:ignore，或把值写进 .pii-allowlist；')
    console.log('  · HIGH 不接受行内豁免，必须脱敏或轮换。')
  }
  return findings.length ? 1 : 0
}

// ── 自检 ─────────────────────────────────────────────────────────────────────
/** 用内置样例验证判定口径；返回失败说明（空数组 = 通过）。样例里的号码全是编的。 */
export function selftest () {
  const allow = loadAllowlist()
  const GHP = `ghp_${'A1b2C3d4'.repeat(4)}AAAA`
  const SK = `sk-${'abcdefghij'.repeat(3)}`
  const JWT = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
  // 样例里的号码全是编的。HIGH 样例用拼接/模板避开字面量（HIGH 不接受豁免，否则扫描器会拦住自己）；
  // MEDIUM 样例行尾加标记（标记在源码行上，不影响传给 detectLine 的字符串）。
  const REAL = '2865432109' // pii-scan:ignore 自检样例（编造）
  const cases = [
    ['HIGH', `token = "${GHP}"`, 'GitHub token'],
    ['HIGH', `key: 'AKIA${'ABCDEFGH'.repeat(2)}'`, 'AWS access key'],
    ['HIGH', `apiKey: '${SK}'`, 'sk- 开头的 key'],
    ['HIGH', `const j = '${JWT}'`, 'JWT'],
    ['HIGH', `tg = '123456789:${'A'.repeat(35)}'`, 'Telegram bot token'],
    ['HIGH', '-----BEGIN RSA ' + 'PRIVATE KEY-----', '私钥'],
    ['HIGH', `cookie: 'BDUSS=${'x'.repeat(30)}'`, '长 cookie'],
    ['HIGH', `Authorization: Bearer ${'t'.repeat(30)}`, 'Bearer'],
    ['HIGH', `proxy: 'https://realuser:${'p'.repeat(8)}@proxy.example:8080'`, 'URL 内嵌非假账号密码'],
    ['HIGH', 'https://x-access-token:${GITHUB_TOKEN}@github.com/acme/widgets.git'.replace('${GITHUB_TOKEN}', 'tok' + 'en123456'), 'URL 里是真实 token 而非变量引用'],
    ['HIGH', `token = "${GHP}" /* pii-scan:ignore */`, 'HIGH 不接受行内豁免'],
    ['MEDIUM', `chatId: 'group:${REAL}'`, '聊天键里的真实形态群号'],
    ['MEDIUM', `ownerQQ: '${REAL}'`, '裸露的真实形态长号'],
    [null, `chatId: 'group:${REAL}' /* pii-scan:ignore */`, 'MEDIUM 接受行内豁免'],
    ['MEDIUM', `phone: '13912345678'`, '手机号'], // pii-scan:ignore 自检样例（编造）
    ['MEDIUM', `mail: 'zhangsan@qq.com'`, '个人邮箱'], // pii-scan:ignore 自检样例（编造）
    ['MEDIUM', `host: '192.168.1.9'`, '私网 IP'], // pii-scan:ignore 自检样例（编造）
    ['MEDIUM', `secret: '${'q7'.repeat(9)}Z'`, '硬编码密钥'],
    [null, `chatId: 'private:10001', group: 'group:333444555'`, '仓库约定的占位号'],
    [null, `placeholder="例如 123456789, 987654321"`, '递增占位号'],
    [null, `ownerQQ: '10000001', botQQ: '20000002'`, '占位区段'],
    [null, 'v1.4.9-test.20261123.2', '日期型版本号'],
    [null, 'time: 1763000000, at: 1700000000', '取整时间戳'],
    [null, 'const P = 2654435761, OFF = 2166136261', 'FNV 常量（allowlist）'],
    [null, `cookie: 'BDUSS=test-secret'`, '短假 cookie'],
    [null, `apiKey: 'sk-123'`, '短假 key'],
    [null, "'.mimosa/reports/task-review-sess_2c268665-781f-4875-a31c-bb72899b71e6.json'", '路径里的 sk- 子串'],
    [null, "check('https://user:pw@www.douyin.com/')", '教程式假账号密码'],
    [null, 'http://192.168.10.1:7890', '面板占位 IP（allowlist）'],
    [null, "fishIds: ['8801234567']", '测试假 fishId（allowlist）'],
    [null, 'at: 1761280000000, cooldownUntil: 1761281200000', '13 位毫秒时间戳']
  ]
  const failures = []
  for (const [want, line, why] of cases) {
    const got = detectLine(line, { allow })
    const sevs = got.map(f => f.sev)
    const ok = want === null ? sevs.length === 0 : sevs.includes(want)
    if (!ok) failures.push(`期望 ${want ?? '无命中'}，实际 [${sevs.join(', ')}]：${why}`)
    for (const f of got) {
      if (f.value.includes(REAL) || f.value.includes(SK.slice(4)) || f.value.includes(GHP.slice(4))) failures.push(`输出未打码：${why}`)
    }
  }
  return failures
}

function runSelftest () {
  const failures = selftest()
  if (failures.length) {
    console.error('PII 扫描器自检未通过：')
    for (const f of failures) console.error(`  ✗ ${f}`)
    return 1
  }
  console.log('PII 扫描器自检通过')
  return 0
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main (argv) {
  const allow = loadAllowlist()
  const [cmd, ...rest] = argv
  if (cmd === 'selftest') return runSelftest()
  if (cmd === 'scan') return report(scanFiles(rest, allow))
  if (cmd === 'git') {
    const spec = rest.join(' ').match(/--range\s+(\S+)/)
    if (spec) return report(scanRange(spec[1], allow))
    return report(scanTree(allow))
  }
  return report(scanTree(allow))
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = main(process.argv.slice(2))
