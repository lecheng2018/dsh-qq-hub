// 审计 S14 的回归锁：发布工作流的最小权限与第三方 Action 固定。
//
// 背景：release.yml 原先整条流程（npm ci / lint / test:all / build）都跑在
// `permissions: contents: write` 下——构建与测试阶段执行的任何东西（含依赖的
// postinstall、npm 生命周期脚本）都能拿着可写 token 改仓库、发 Release。
//
// 修复：拆成 build（contents: read）+ publish（contents: write，只做发布，
// 不跑任何构建）；第三方 Action 全部固定到 commit SHA（tag 可被移动，
// SHA 不行）。
//
// 这个测试用静态解析钉住上述结构，防止以后有人图省事把写权限挪回工作流级，
// 或者把 `uses: actions/checkout@v4` 这类浮动 tag 写回来。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 极简 YAML 读取：只取本测试需要的结构，不引依赖。 */
function parseYamlLite(text) {
  const lines = text.split(/\r?\n/)
  const doc = { jobs: {}, top: {} }
  let inJobs = false
  let curJob = null
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      const m = /^([\w-]+):(.*)$/.exec(line.trim())
      if (!m) continue
      inJobs = m[1] === 'jobs'
      if (!inJobs) doc.top[m[1]] = m[2].trim()
      curJob = null
      continue
    }
    if (inJobs && indent === 2) {
      const m = /^([\w-]+):(.*)$/.exec(line.trim())
      if (m) {
        curJob = m[1]
        doc.jobs[curJob] = { raw: [], permissions: {}, uses: [], needs: null, if: null, outputs: {} }
      }
      continue
    }
    if (!curJob) continue
    const job = doc.jobs[curJob]
    job.raw.push(line)
    const t = line.trim()
    if (/^uses:\s*\S+/.test(t)) job.uses.push(t.replace(/^uses:\s*/, '').split(/\s+/)[0])
    if (/^needs:\s*\S+/.test(t)) job.needs = t.replace(/^needs:\s*/, '').trim()
    if (/^if:\s*/.test(t)) job.if = t.replace(/^if:\s*/, '').trim()
    if (indent === 4 && /^permissions:/.test(t)) job.permissionsBlockAt = true
    const perm = /^contents:\s*(\w+)/.exec(t)
    if (perm && indent >= 6) job.permissions.contents = perm[1]
    const out = /^([\w-]+):\s*\$\{\{\s*steps\.meta\.outputs\.([\w-]+)\s*\}\}/.exec(t)
    if (out && indent >= 6) job.outputs[out[1]] = out[2]
  }
  return doc
}

const doc = parseYamlLite(read('.github/workflows/release.yml'))

test('S14 · 工作流级权限是只读（写权限不能放在工作流级）', () => {
  // 逐行解析而不是正则跨行：permissions 块里夹着解释性注释，跨行正则会被注释挡住
  // （第一版就是这么写错的——测试自己挂了，不是工作流的问题）。
  const lines = read('.github/workflows/release.yml').split(/\r?\n/)
  const start = lines.findIndex((l) => /^permissions:\s*$/.test(l))
  assert.ok(start >= 0, '应显式声明工作流级 permissions')
  let found = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (!/^\s/.test(line)) break // 回到顶层：permissions 块结束
    if (/^\s*#/.test(line)) continue // 注释跳过
    const m = /^\s+contents:\s*(\w+)/.exec(line)
    if (m) { found = m[1]; break }
  }
  assert.ok(found, 'permissions 块里应声明 contents')
  assert.equal(found, 'read', '工作流级必须 contents: read')
})

test('S14 · 构建 job 只读，发布 job 独占写权限，且发布 job 不跑构建', () => {
  const { jobs } = doc
  const build = Object.keys(jobs).find((j) => /build|test/.test(j))
  const publish = Object.keys(jobs).find((j) => /publish|release/.test(j))
  assert.ok(build, '应有构建 job')
  assert.ok(publish, '应有发布 job')
  assert.equal(jobs[build].permissions.contents, 'read', '构建 job 必须 contents: read')
  assert.equal(jobs[publish].permissions.contents, 'write', '发布 job 需要 contents: write')
  assert.equal(jobs[publish].needs, build, '发布 job 必须依赖构建 job')
  assert.match(jobs[publish].if || '', /needs\..*\.outputs\.skip/, '发布 job 应受 skip 输出控制')

  // 发布 job 里不得出现安装依赖 / 跑测试 / 打包（只允许下载产物 + 发布）
  const publishRaw = jobs[publish].raw.join('\n')
  for (const forbidden of ['npm ci', 'npm run', 'npm pack', 'npm test']) {
    assert.ok(!publishRaw.includes(forbidden), `发布 job 不应执行 ${forbidden}`)
  }
})

test('S14 · 所有第三方 Action 固定到 40 位 commit SHA，不用浮动 tag', () => {
  const text = read('.github/workflows/release.yml')
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  assert.ok(uses.length >= 4, `应解析到多个 Action，实际 ${uses.length}`)
  for (const u of uses) {
    const at = u.lastIndexOf('@')
    assert.ok(at > 0, `uses 缺少版本引用：${u}`)
    const ref = u.slice(at + 1)
    assert.match(ref, /^[0-9a-f]{40}$/, `${u} 未固定到 commit SHA（tag 可被移动）`)
  }
})

test('S14 · checkout 不把凭据持久化进 .git/config', () => {
  const text = read('.github/workflows/release.yml')
  assert.match(text, /persist-credentials:\s*false/, 'checkout 应关闭 persist-credentials')
  // 关掉之后拉 tag 必须显式带 token，否则仓库转私有会静默失败
  assert.match(text, /git fetch --tags/, '仍需要拉 tag 做幂等判断')
  assert.match(text, /x-access-token/, '拉 tag 时应显式使用只读 token')
})

test('S14 · 一次运行里不再重复构建 client（Q20，随本 PR 一并修正）', () => {
  const text = read('.github/workflows/release.yml')
  const explicit = [...text.matchAll(/run:\s*npm run build:client/g)]
  assert.equal(explicit.length, 0, '不应再有显式 build:client 步骤（test:all 与 prepack 已覆盖）')
})
