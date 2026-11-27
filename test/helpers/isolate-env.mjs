// 全局测试环境隔离（通过 `node --import ./test/helpers/isolate-env.mjs --test ...` 注入）。
// 目标：无论单个测试文件是否手动设置了临时目录，所有测试进程启动时都强制把
// DSH_QQ_HUB_DATA_DIR / AURABOT_DATA_DIR / DSH_HOME 隔离到独立临时目录，
// 防止任何遗漏或异步残留日志落入本机真实生产目录；进程退出时清理自建的临时目录。

import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

function realOrResolve(p) {
  const abs = resolve(String(p))
  try { return realpathSync(abs) } catch { return abs }
}

const TMP_ROOT = realOrResolve(tmpdir())

function isIsolatedTempPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return false
  const target = realOrResolve(raw)
  const rel = relative(TMP_ROOT, target)
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel)
}

// 如果是由父级测试进程通过本 helper 注入的环境变量，子测试进程应为自己建一份独立临时目录，
// 避免并发测试文件共享同一个目录互相踩踏，或父进程提前清理。
const inheritedFromHelper = process.env.QQHUB_TEST_ISOLATED_BY === 'isolate-env'
  && process.env.QQHUB_TEST_ISOLATION_PID !== String(process.pid)

const needData = inheritedFromHelper || !isIsolatedTempPath(process.env.DSH_QQ_HUB_DATA_DIR)
const needLegacy = inheritedFromHelper || !isIsolatedTempPath(process.env.AURABOT_DATA_DIR)
const needHome = inheritedFromHelper || !isIsolatedTempPath(process.env.DSH_HOME)

let createdRoot = ''
function ensureRoot() {
  if (!createdRoot) createdRoot = mkdtempSync(join(tmpdir(), 'qqhub-test-env-'))
  return createdRoot
}

if (needData || needLegacy) {
  const dataRoot = join(ensureRoot(), 'data')
  mkdirSync(dataRoot, { recursive: true })
  if (needData) process.env.DSH_QQ_HUB_DATA_DIR = dataRoot
  if (needLegacy) process.env.AURABOT_DATA_DIR = needData ? dataRoot : process.env.DSH_QQ_HUB_DATA_DIR
  // 记录基线隔离目录：让只覆盖了 AURABOT_DATA_DIR 的老测试仍能覆盖默认的 DSH_QQ_HUB_DATA_DIR。
  process.env.QQHUB_TEST_ISOLATION_DIR = process.env.DSH_QQ_HUB_DATA_DIR
}

if (needHome) {
  const homeRoot = join(ensureRoot(), 'dsh-home')
  mkdirSync(homeRoot, { recursive: true })
  process.env.DSH_HOME = homeRoot
}

if (!process.env.QQHUB_TEST_ISOLATION_DIR && process.env.DSH_QQ_HUB_DATA_DIR && process.env.DSH_QQ_HUB_DATA_DIR === process.env.AURABOT_DATA_DIR) {
  process.env.QQHUB_TEST_ISOLATION_DIR = process.env.DSH_QQ_HUB_DATA_DIR
}

if (createdRoot || !process.env.QQHUB_TEST_ISOLATED_BY) {
  process.env.QQHUB_TEST_ISOLATED_BY = 'isolate-env'
  process.env.QQHUB_TEST_ISOLATION_PID = String(process.pid)
}

if (createdRoot) {
  process.on('exit', () => {
    try { rmSync(createdRoot, { recursive: true, force: true }) } catch {}
  })
}
