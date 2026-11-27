// 回归：测试环境全局隔离（isolate-env.mjs）、store.js fail-closed、logger.js 固化目录与单行折行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { dataDir } from '../src/core/store.js'
import { createLogger } from '../src/core/logger.js'

const ISOLATE = resolve(process.cwd(), 'test', 'helpers', 'isolate-env.mjs')

function underTmp(p) {
  const rel = relative(resolve(tmpdir()), resolve(String(p || '')))
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

test('isolate-env.mjs：自动把三个目录环境变量隔离到临时目录，并在进程退出时清理', () => {
  const env = { ...process.env }
  delete env.DSH_QQ_HUB_DATA_DIR
  delete env.AURABOT_DATA_DIR
  delete env.DSH_HOME
  delete env.QQHUB_TEST_ISOLATED_BY
  delete env.QQHUB_TEST_ISOLATION_PID
  delete env.QQHUB_TEST_ISOLATION_DIR
  // 模拟调用方把 DSH_HOME 指到非临时生产路径，也应被强制覆盖为临时目录
  env.DSH_HOME = '/vol2/fake-prod/.dsh'

  const out = execFileSync(process.execPath, [
    '--import', ISOLATE,
    '-e',
    'console.log(JSON.stringify({ d: process.env.DSH_QQ_HUB_DATA_DIR, a: process.env.AURABOT_DATA_DIR, h: process.env.DSH_HOME }))',
  ], { env, encoding: 'utf8' })

  const parsed = JSON.parse(out.trim())
  assert.ok(underTmp(parsed.d), `DSH_QQ_HUB_DATA_DIR 应在 tmpdir 内：${parsed.d}`)
  assert.ok(underTmp(parsed.a), `AURABOT_DATA_DIR 应在 tmpdir 内：${parsed.a}`)
  assert.ok(underTmp(parsed.h), `DSH_HOME 应在 tmpdir 内：${parsed.h}`)
  assert.notEqual(parsed.h, '/vol2/fake-prod/.dsh')
  // 子进程退出后临时根目录应已被清理
  assert.equal(existsSync(parsed.d), false, '进程 exit 时应清理自建临时数据目录')
  assert.equal(existsSync(parsed.h), false, '进程 exit 时应清理自建临时 DSH_HOME')
})

test('store.js dataDir()：测试上下文里两个数据目录变量都未设时 fail-closed 抛错', () => {
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  const prevAllow = process.env.QQHUB_ALLOW_DEFAULT_DATA_DIR_IN_TEST
  const prevHome = process.env.DSH_HOME
  const fakeHome = mkdtempSync(join(tmpdir(), 'qqhub-default-home-'))
  try {
    delete process.env.DSH_QQ_HUB_DATA_DIR
    delete process.env.AURABOT_DATA_DIR
    delete process.env.QQHUB_ALLOW_DEFAULT_DATA_DIR_IN_TEST
    process.env.DSH_HOME = fakeHome

    assert.throws(() => dataDir('config.json'), /测试环境禁止/)

    // 显式允许时才放行，且仍落到隔离的 DSH_HOME
    process.env.QQHUB_ALLOW_DEFAULT_DATA_DIR_IN_TEST = '1'
    const resolved = dataDir('config.json')
    assert.equal(resolved, join(fakeHome, 'plugins-data', 'dsh-qq-hub', 'config.json'))
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    if (prevAllow === undefined) delete process.env.QQHUB_ALLOW_DEFAULT_DATA_DIR_IN_TEST
    else process.env.QQHUB_ALLOW_DEFAULT_DATA_DIR_IN_TEST = prevAllow
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('logger.js：构造时固化日志目录，env 变更后不漂移；多行文本写盘折叠为单行', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'qqhub-log-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'qqhub-log-b-'))
  const prevPrimary = process.env.DSH_QQ_HUB_DATA_DIR
  const prevLegacy = process.env.AURABOT_DATA_DIR
  try {
    process.env.DSH_QQ_HUB_DATA_DIR = dirA
    process.env.AURABOT_DATA_DIR = dirA
    const logger = createLogger()
    const log = logger.child('test')

    // 模拟 afterEach 把环境变量切到别处
    process.env.DSH_QQ_HUB_DATA_DIR = dirB
    process.env.AURABOT_DATA_DIR = dirB

    log.info('第一行\n第二行\r\n第三行')
    log.warn('第二条单行日志')

    const filesA = readdirSync(join(dirA, 'logs')).filter((n) => n.endsWith('.log'))
    assert.equal(filesA.length, 1, '日志应继续落在构造时固化的 dirA/logs')
    assert.equal(existsSync(join(dirB, 'logs')), false, '不得漂移写到变更后的 dirB')

    const lines = readFileSync(join(dirA, 'logs', filesA[0]), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, '2 条日志在文件里必须严格占 2 行')
    assert.match(lines[0], /第一行 ↵ 第二行 ↵ 第三行/)
    assert.match(lines[1], /第二条单行日志/)
  } finally {
    if (prevPrimary === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevPrimary
    if (prevLegacy === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevLegacy
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('logger.js：支持显式传入 dir 参数指定日志目录', () => {
  const customDir = mkdtempSync(join(tmpdir(), 'qqhub-log-custom-'))
  try {
    const logger = createLogger({ dir: customDir })
    logger.child('custom').info('hello')
    const files = readdirSync(customDir).filter((n) => n.endsWith('.log'))
    assert.equal(files.length, 1)
  } finally {
    rmSync(customDir, { recursive: true, force: true })
  }
})
