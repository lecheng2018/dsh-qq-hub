// 交付台账增量 WAL（write-ahead log）：append-only JSONL + 定期压缩快照。
// 目的：把「每次 enqueue/mark 全量写 2000 条 JSON + 双重全量 readFileSync+JSON.parse 预检」
// 改为「单条事件追加 + 达到阈值时一次性压缩」，降低同步 I/O 与写盘体积。

import { appendFileSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir, writeJsonWithBackup } from '../core/store.js'

export const DEFAULT_WAL_COMPACT_THRESHOLD = 100 // 条事件
export const DEFAULT_WAL_COMPACT_BYTES = 256 * 1024 // 256KB

/**
 * 创建一个轻量 WAL 写入器。
 * @param {string} file 主快照文件路径（与既有 deliveries.json 同路径）
 * @param {{ threshold?: number, maxBytes?: number, onError?: (error: Error) => void }} [opts]
 */
export function createWalWriter(file, { threshold = DEFAULT_WAL_COMPACT_THRESHOLD, maxBytes = DEFAULT_WAL_COMPACT_BYTES, onError = () => {}, validate = () => true, label = '投递台账' } = {}) {
  const walFile = `${file}.wal.jsonl`
  let pendingEvents = 0

  function walSize() {
    try { return statSync(walFile).size } catch { return 0 }
  }

  /** 追加一条事件；critical=true 时立即 fsync（fail-closed 由调用方处理）。 */
  function append(event, { critical = false } = {}) {
    ensureDir(dirname(file))
    // 若主快照位置被目录占用，writeJsonWithBackup 必失败；这里先做一次轻量探测，
    // 让「目录占位」这类故障在 critical 路径立即抛出，而不是静默吞掉。
    if (critical) {
      try {
        const st = statSync(file)
        if (st.isDirectory()) throw Object.assign(new Error(`快照路径是目录：${file}`), { code: 'EISDIR' })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const line = JSON.stringify({ ...event, at: Date.now() }) + '\n'
    if (critical) {
      const fd = openSync(walFile, 'a')
      try {
        writeFileSync(fd, line, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      appendFileSync(walFile, line, 'utf8')
    }
    pendingEvents += 1
  }

  /** 读取 WAL 中的合法事件（尾部半行安全忽略）。 */
  function readEvents() {
    let text
    try { text = readFileSync(walFile, 'utf8') } catch { return [] }
    const events = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch {
        // 尾部半截 JSON（崩溃时写了一半）安全忽略
        onError(new Error(`WAL 行损坏已跳过：${line.slice(0, 80)}`))
      }
    }
    return events
  }

  /** 当前 WAL 是否达到压缩阈值。 */
  function needsCompact() {
    return pendingEvents >= threshold || walSize() >= maxBytes
  }

  /**
   * 压缩：由调用方提供当前完整状态快照，写入主文件并截断 WAL。
   * critical=true 时走 requireBackup：主文件与 .bak 都必须写成，任一失败即抛给调用方 fail-closed。
   */
  function compact(snapshot, { critical = false } = {}) {
    ensureDir(dirname(file))
    // 走既有 writeJsonWithBackup：保留「损坏原件隔离 + .bak 同步 + 失败即抛」语义，
    // 避免自行 writeFileSync 破坏 state-corruption 契约（无法隔离时必须 fail-closed）。
    writeJsonWithBackup(file, snapshot, { validate, label, onError, requireBackup: critical })
    // 截断 WAL
    try { unlinkSync(walFile) } catch {}
    pendingEvents = 0
  }

  return { append, readEvents, needsCompact, compact, walFile, pendingCount: () => pendingEvents }
}
