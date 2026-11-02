// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件所有数据放这儿：优先 ~/.dsh/plugins-data/dsh-qq-hub/，自动兼容继承老用户历史数据 */
export function dataDir(...parts) {
  const envDir = process.env.DSH_QQ_HUB_DATA_DIR || process.env.AURABOT_DATA_DIR
  if (envDir) return join(envDir, ...parts)
  const home = join(dshHome(), 'plugins-data')
  const newBase = join(home, 'dsh-qq-hub')
  const legacyBase = join(home, 'aurabot')
  const base = existsSync(newBase) || !existsSync(legacyBase) ? newBase : legacyBase
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function renameWithRetry(from, to, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (i === attempts - 1 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err
      const end = Date.now() + 25
      while (Date.now() < end) {}
    }
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameWithRetry(tmp, file)
}

export { existsSync }
