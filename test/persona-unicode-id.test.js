// 回归：人设 id 支持中文（safeId 不能把中文洗成空串）。
// 背景：safeId 原本用 /[^a-zA-Z0-9_-]/g 过滤，中文 id 会被清空，
// 于是 readPersona('小肥鱼') 读不到文件、currentPersonaText 静默回退到第一张卡，
// 表现为「改了人设却还在用旧卡说话」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

// 用独立的 data 目录，避免测试写进真实的 personas 目录
const dataRoot = join(tmpdir(), `persona-unicode-data-${process.pid}`)
process.env.DSH_QQ_HUB_DATA_DIR = dataRoot

const { savePersona, readPersona } = await import(`file:///${REPO}/src/persona/personas.js`)

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

test('safeId 保留中文与数字，只剔除路径危险字符', () => {
  const src = readFileSync(join(REPO, 'src/persona/personas.js'), 'utf8')
  assert.match(src, /safeId = \(id\) =>[^\n]*\\p\{L\}[^\n]*\\p\{N\}/, 'safeId 必须用 Unicode 字母/数字类，不能只留 ASCII')
  assert.doesNotMatch(src, /safeId = \(id\) =>[^\n]*\[\^a-zA-Z0-9_\-\]/, '不能再用纯 ASCII 白名单（会把中文洗空）')
})

test('中文 id 能被安全地存成文件并读回来', () => {
  const saved = savePersona('小肥鱼', { name: '小肥鱼', tags: ['仿真'], body: '正文测试' })
  assert.equal(saved.id, '小肥鱼', 'id 不能被洗成空串')
  assert.equal(saved.name, '小肥鱼')
  const read = readPersona('小肥鱼')
  assert.ok(read, '中文 id 必须能读回来')
  assert.equal(read.body, '正文测试')
})

test('路径穿越类 id 依然被拦掉', () => {
  const saved = savePersona('../../etc/passwd', { name: 'x', tags: [], body: 'y' })
  assert.doesNotMatch(saved.id, /[./\\]/, '不能留下路径分隔符')
})
