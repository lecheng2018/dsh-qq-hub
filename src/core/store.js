// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

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

export function writeJson(file, value, { mode = 0o644 } = {}) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w', mode)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8')
    // rename 前 fsync：进程 kill -9 时不丢已确认写入的数据（tmp+rename 只保证不写半截，
    // 但页缓存没刷的话重启后 rename 的文件内容可能是旧的 —— P1-6 持久化窗口）
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, file)
}

let corruptFileSeq = 0

function stateCandidate(file, validate) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'missing' : 'io', error }
  }
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const value = JSON.parse(text)
    if (!validate(value)) throw new TypeError('JSON 状态结构不符合预期')
    return { kind: 'valid', value }
  } catch (error) {
    return { kind: 'invalid', error }
  }
}

function quarantineState(file) {
  let archived
  for (;;) {
    archived = `${file}.corrupt-${Date.now()}-${process.pid}-${++corruptFileSeq}`
    try {
      closeSync(openSync(archived, 'wx', 0o600))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  try {
    renameWithRetry(file, archived)
    return archived
  } catch (error) {
    try { unlinkSync(archived) } catch (cleanupError) {
      throw new Error(`${error.message}；清理占位文件 ${archived} 失败：${cleanupError.message}`, { cause: error })
    }
    throw error
  }
}

const warnState = (error) => console.warn(error.message)
const reportedEmptyStates = new Set()

export function readJsonWithBackup(file, { fallback, validate, label = '状态文件', onError = warnState, repairPrimary = true } = {}) {
  const primary = stateCandidate(file, validate)
  if (primary.kind === 'valid') return { value: primary.value, error: null }

  const backupFile = `${file}.bak`
  const backup = stateCandidate(backupFile, validate)
  if (primary.kind === 'missing' && backup.kind === 'missing') {
    const value = typeof fallback === 'function' ? fallback() : fallback
    if (reportedEmptyStates.has(file)) return { value, error: null }
    let archives
    try {
      const prefix = basename(file)
      archives = readdirSync(dirname(file)).filter((name) => name.startsWith(`${prefix}.corrupt-`) || name.startsWith(`${prefix}.bak.corrupt-`))
    } catch (error) {
      if (error?.code === 'ENOENT') return { value, error: null }
      const warning = new Error(`${label}：无法检查 ${dirname(file)} 中的损坏原件：${error.message}；历史状态可能缺失`)
      onError(warning)
      return { value, error: warning }
    }
    if (archives.length === 0) return { value, error: null }
    const error = new Error(`${label}：主文件和备份不存在，但发现损坏原件 ${archives.map((name) => join(dirname(file), name)).join('、')}；以空状态启动，历史状态可能缺失`)
    reportedEmptyStates.add(file)
    onError(error)
    return { value, error }
  }

  const details = []
  let canRestore = primary.kind === 'missing'
  for (const [candidate, candidateFile] of [[primary, file], [backup, backupFile]]) {
    if (candidate.kind === 'invalid') {
      try {
        const archived = quarantineState(candidateFile)
        details.push(`${candidateFile} 损坏，原件已保留为 ${archived}（${candidate.error.message}）`)
        if (candidateFile === file) canRestore = true
      } catch (error) {
        details.push(`${candidateFile} 损坏且无法保留原件：${error.message}`)
      }
    } else if (candidate.kind === 'io') {
      details.push(`${candidateFile} 读取失败：${candidate.error.message}`)
    }
  }
  if (primary.kind === 'missing') details.push(`${file} 不存在`)
  if (backup.kind === 'missing') details.push(`${backupFile} 不存在`)

  if (backup.kind === 'valid') {
    if (!repairPrimary) {
      details.push(`已读取 ${backupFile}，主文件将在恢复状态后修复`)
    } else if (canRestore) {
      try {
        writeJson(file, backup.value)
        details.push(`已从 ${backupFile} 恢复主文件`)
      } catch (error) {
        details.push(`已读取 ${backupFile}，但恢复主文件失败：${error.message}`)
      }
    } else {
      details.push(`已读取 ${backupFile}，主文件未修复`)
    }
    const warning = new Error(`${label}：${details.join('；')}；备份可能不是最新状态`)
    onError(warning)
    return { value: backup.value, error: null, fromBackup: true }
  }

  const error = new Error(`${label}：${details.join('；')}；无可用备份，以空状态启动，历史状态可能缺失`)
  reportedEmptyStates.add(file)
  onError(error)
  return { value: typeof fallback === 'function' ? fallback() : fallback, error }
}

export function writeJsonWithBackup(file, value, { validate, label = '状态文件', onError = warnState, mode = 0o644 } = {}) {
  if (!validate(value)) throw new TypeError(`${label}结构不符合预期`)
  for (const candidateFile of [file, `${file}.bak`]) {
    const candidate = stateCandidate(candidateFile, validate)
    if (candidate.kind === 'io') throw candidate.error
    if (candidate.kind === 'invalid') {
      const archived = quarantineState(candidateFile)
      onError(new Error(`${label}：${candidateFile} 损坏，原件已保留为 ${archived}（${candidate.error.message}）`))
    }
  }
  writeJson(file, value, { mode })
  writeJson(`${file}.bak`, value, { mode })
}

export { existsSync }
