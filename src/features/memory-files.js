// 记忆 Markdown 文件存储驱动（1.3.65 重构 A-02）。
//
// 职责：
//   1. 管理 memory/ 目录：按聊天隔离存放 memory.md（global/, private/<uid>/, group/<gid>/）。
//   2. 运行状态（hits、处理进度 processed、runs、目标设置等）存放在 state.json。
//   3. 实现单作用域原子落盘（.tmp + fsync + 操作系统原子 renameSync），防止半截损坏。
//   4. 内存镜像与 diff 校验：对外保持与 memory.js 完全兼容的 load() 与 save(s) 契约。
//   5. 文件大小守卫：单个 memory.md 超过 2 MiB 拦截并告警。

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { renameWithRetry } from '../core/store.js'
import { parseMarkdownArchive, serializeMarkdownArchive, MEMORY_FORMAT } from './memory-markdown.js'

export const MAX_SCOPE_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB 单文件硬守卫

/**
 * 将作用域映射为合法安全的相对文件路径
 * @param {string} scope 作用域（如 "global", "private:10001", "group:20001", "quarantine"）
 * @returns {string} 相对路径（如 "global/memory.md", "private/10001/memory.md"）
 */
export function scopeToFilePath(scope) {
  const s = String(scope || '').trim()
  if (!s || s === 'global') return join('global', 'memory.md')
  if (s === 'quarantine') return join('quarantine', 'memory.md')

  const parts = s.split(':')
  if (parts.length === 2) {
    const kind = parts[0].toLowerCase()
    const id = parts[1].trim()
    // 安全校验：禁止路径穿越与非法字符
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(id)) {
      throw new Error(`非法的作用域 ID: "${id}"`)
    }
    if (kind === 'private' || kind === 'group' || kind === 'system') {
      return join(kind, id, 'memory.md')
    }
    if (kind === 'qq') {
      return join('private', id, 'memory.md')
    }
  }

  // 兜底其它单层安全标识
  const safeStr = s.replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  return join('custom', safeStr, 'memory.md')
}

/**
 * 将 insight/style 的 key 统一映射为其归属的 scope
 */
function personKeyToScope(key) {
  const k = String(key || '').trim()
  if (!k || k === 'self' || k === 'global') return 'global'
  if (k.startsWith('qq:')) return `private:${k.slice(3)}`
  if (k.startsWith('private:')) return k
  if (k.startsWith('group:')) return k
  return 'global'
}

/**
 * 原子写入文本文件（写 tmp -> fsync -> rename）
 */
export function writeTextAtomic(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, filePath)
}

/**
 * 递归扫描 memory 根目录下所有 memory.md 文件
 */
function scanMemoryFiles(memoryDir) {
  const mdFiles = []
  if (!existsSync(memoryDir)) return mdFiles

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name !== 'quarantine' && ent.name !== 'backup') {
          walk(full)
        }
      } else if (ent.isFile() && ent.name === 'memory.md') {
        mdFiles.push(full)
      }
    }
  }

  try {
    walk(memoryDir)
  } catch (err) {
    // 忽略目录无法读取的极端情况
  }
  return mdFiles
}

/**
 * 打开基于 Markdown + state.json 的文件记忆存储层
 * @param {string} memoryDir 数据根目录（通常为 <dataDir>/memory）
 * @param {object} [options]
 * @returns {object} { load, save, close, stats, getScopeArchive, commitScope }
 */
export function openMemoryFiles(memoryDir, { log = console } = {}) {
  mkdirSync(memoryDir, { recursive: true })
  const stateFile = join(memoryDir, 'state.json')

  let rev = 1
  let closed = false

  // 读写锁与缓存
  const scopeSnapshots = new Map() // scope -> { rawText, entries, prologue, mtimeMs, file }
  let stateSnapshot = {
    version: 1,
    hits: {},
    processed: {},
    runs: {},
    lastConsolidate: {},
    distillTargets: [],
    insightNames: {},
    slang: {},
  }

  // 加载 state.json
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      stateSnapshot = { ...stateSnapshot, ...parsed }
    } catch (err) {
      log.warn?.('读取 state.json 失败，使用默认运行状态:', err.message)
    }
  }

  // 加载所有 scope 的 memory.md
  function reloadAllScopes() {
    scopeSnapshots.clear()
    const mdFiles = scanMemoryFiles(memoryDir)
    for (const file of mdFiles) {
      try {
        const raw = readFileSync(file, 'utf8')
        const stat = statSync(file)
        const parsed = parseMarkdownArchive(raw)
        const scope = parsed.meta.scope
        scopeSnapshots.set(scope, {
          rawText: raw,
          entries: parsed.entries,
          prologue: parsed.prologue,
          mtimeMs: stat.mtimeMs,
          file,
        })
      } catch (err) {
        log.error?.(`解析记忆文档失败: ${file}:`, err.message)
      }
    }
  }

  reloadAllScopes()

  /**
   * 将内存各 scope 数据聚合为与旧 memory.js 完全一致的数据模型
   */
  function assembleState() {
    const items = []
    const profiles = {}
    const insights = {}
    const styles = { self: [] }
    const distill = {}

    const hitsMap = stateSnapshot.hits || {}

    for (const [scope, snap] of scopeSnapshots) {
      for (const e of snap.entries) {
        const kind = e.kind || 'fact'

        if (kind === 'fact') {
          const hitInfo = hitsMap[e.id] || {}
          items.push({
            id: e.id,
            text: e.text || '',
            about: e.about || '',
            aboutName: e.aboutName || '',
            tags: e.tags || [],
            importance: typeof e.importance === 'number' ? e.importance : 0.5,
            source: e.source || 'tool',
            sourceId: e.sourceId || '',
            chatId: e.chatId || '',
            scope: scope,
            at: typeof e.at === 'number' ? e.at : Date.now(),
            eventAt: typeof e.eventAt === 'number' ? e.eventAt : undefined,
            entity: e.entity || undefined,
            topic: e.topic || undefined,
            hits: Number(hitInfo.hits || e.hits || 0),
            hitDays: Number(hitInfo.hitDays || e.hitDays || 0),
            lastHit: Number(hitInfo.lastHit || e.lastHit || 0),
            clarity: e.clarity || 'vivid',
            invalidAt: Number(e.invalidAt || 0),
            pinned: e.pinned ? 1 : 0,
            retention: Number(e.retention || 0),
            embeddedAt: Number(e.embeddedAt || 0),
            supersededBy: e.supersededBy || undefined,
            history: e.history || undefined,
            ephemeral: e.ephemeral ? 1 : undefined,
            title: e.title || undefined,
            evidence: e.evidence || undefined,
            revision: e.revision || undefined,
          })
        } else if (kind === 'profile') {
          const key = `${e.about || ''}@${scope}`
          profiles[key] = {
            name: e.aboutName || '',
            qq: e.about || '',
            scope: scope,
            text: e.text || '',
            at: typeof e.at === 'number' ? e.at : Date.now(),
          }
        } else if (kind === 'insight') {
          // 还原 memory.js 期望的键名：私聊对应 qq:<uid>，群聊对应 group:<gid>
          const insKey = scope.startsWith('private:') ? `qq:${scope.slice(8)}` : scope
          insights[insKey] = insights[insKey] || []
          insights[insKey].push({
            id: e.id,
            text: e.text || '',
            at: typeof e.at === 'number' ? e.at : Date.now(),
          })
        } else if (kind === 'style') {
          if (scope === 'global' && e.id === 'self') {
            try {
              styles.self = JSON.parse(e.text || '[]')
            } catch {
              styles.self = e.text ? e.text.split('\n').filter(Boolean) : []
            }
          } else {
            const styKey = scope.startsWith('private:') ? `qq:${scope.slice(8)}` : scope
            styles[styKey] = styles[styKey] || []
            try {
              const list = JSON.parse(e.text || '[]')
              if (Array.isArray(list)) styles[styKey].push(...list)
              else styles[styKey].push(e.text)
            } catch {
              styles[styKey].push(e.text)
            }
          }
        } else if (kind === 'distill-profile') {
          const gid = e.about || ''
          const uid = e.sourceId || ''
          const key = `group:${gid}#${uid}`
          try {
            distill[key] = JSON.parse(e.text || '{}')
          } catch {
            distill[key] = { text: e.text }
          }
        }
      }
    }

    return {
      items,
      profiles,
      insights,
      styles,
      distill,
      distillTargets: stateSnapshot.distillTargets || [],
      insightNames: stateSnapshot.insightNames || {},
      slang: stateSnapshot.slang || {},
      processed: stateSnapshot.processed || {},
      runs: stateSnapshot.runs || {},
      lastConsolidate: stateSnapshot.lastConsolidate || {},
      rev,
    }
  }

  /**
   * 提交单个 scope 的更新至 Markdown 文档
   */
  function commitScopeDocument(scope, newEntries, prologue = '') {
    if (closed) throw new Error('记忆存储已关闭，拒绝提交')

    const relPath = scopeToFilePath(scope)
    const absPath = join(memoryDir, relPath)

    if (newEntries.length === 0) {
      if (existsSync(absPath)) {
        try { unlinkSync(absPath) } catch {}
      }
      scopeSnapshots.delete(scope)
      rev++
      return
    }

    const archive = {
      meta: {
        format: MEMORY_FORMAT,
        scope,
      },
      entries: newEntries,
      prologue,
    }

    const markdownText = serializeMarkdownArchive(archive)

    // 文件大小防卫（2 MiB）
    if (Buffer.byteLength(markdownText, 'utf8') > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`记忆档案超限: 作用域 ${scope} 大小超过 ${MAX_SCOPE_FILE_BYTES / 1024 / 1024} MiB 上限，已阻止写入`)
    }

    // 检查磁盘外部并发修改冲突（如果文件已存在）
    const prevSnap = scopeSnapshots.get(scope)
    if (prevSnap && existsSync(absPath)) {
      const currentStat = statSync(absPath)
      if (Math.abs(currentStat.mtimeMs - prevSnap.mtimeMs) > 100) {
        const diskRaw = readFileSync(absPath, 'utf8')
        if (diskRaw !== prevSnap.rawText) {
          log.warn?.(`检测到外部程序修改了 ${absPath}，中止本次覆盖以保护人工修改`)
          throw new Error(`作用域 ${scope} 的 memory.md 已在外部被修改，请先重载档案`)
        }
      }
    }

    // 原子写入
    writeTextAtomic(absPath, markdownText)

    const newStat = statSync(absPath)
    scopeSnapshots.set(scope, {
      rawText: markdownText,
      entries: newEntries,
      prologue,
      mtimeMs: newStat.mtimeMs,
      file: absPath,
    })

    rev++
  }

  /**
   * 同步更新并保存 state.json
   */
  function commitState(changes) {
    if (closed) return
    stateSnapshot = {
      ...stateSnapshot,
      ...changes,
      updatedAt: Date.now(),
    }
    const stateText = JSON.stringify(stateSnapshot, null, 2)
    writeTextAtomic(stateFile, stateText)
  }

  return {
    load: () => {
      if (closed) throw new Error('记忆存储已关闭')
      return assembleState()
    },

    save: (s) => {
      if (closed) throw new Error('记忆存储已关闭')

      // 1. 同步更新 state.json 中的元数据
      const stateChanges = {}
      if (s.distillTargets) stateChanges.distillTargets = s.distillTargets
      if (s.insightNames) stateChanges.insightNames = s.insightNames
      if (s.slang) stateChanges.slang = s.slang
      if (s.processed) stateChanges.processed = s.processed
      if (s.runs) stateChanges.runs = s.runs
      if (s.lastConsolidate) stateChanges.lastConsolidate = s.lastConsolidate

      // 收集并记录 items 上的 hits/lastHit 统计，避免污染 Markdown 正文
      const hitsMap = stateSnapshot.hits || {}
      let hitsChanged = false
      for (const it of s.items || []) {
        if (it.hits || it.lastHit) {
          const old = hitsMap[it.id]
          if (!old || old.hits !== it.hits || old.lastHit !== it.lastHit || old.hitDays !== it.hitDays) {
            hitsMap[it.id] = { hits: it.hits, lastHit: it.lastHit, hitDays: it.hitDays }
            hitsChanged = true
          }
        }
      }
      if (hitsChanged) stateChanges.hits = hitsMap
      commitState(stateChanges)

      // 2. 按 scope 分组条目，仅更新发生变动的 scope 的 memory.md
      const byScope = new Map() // scope -> entries

      // 收集 facts
      for (const it of s.items || []) {
        const sc = it.scope || 'global'
        if (!byScope.has(sc)) byScope.set(sc, [])
        byScope.get(sc).push({
          id: it.id,
          kind: 'fact',
          about: it.about,
          aboutName: it.aboutName,
          title: it.title,
          text: it.text,
          evidence: it.evidence,
          revision: it.revision,
          at: it.at,
          eventAt: it.eventAt,
          importance: it.importance,
          pinned: it.pinned ? 1 : undefined,
          ephemeral: it.ephemeral ? 1 : undefined,
          invalidAt: it.invalidAt || undefined,
          supersededBy: it.supersededBy || undefined,
          history: it.history,
          tags: it.tags,
          source: it.source,
          sourceId: it.sourceId,
          chatId: it.chatId || undefined,
          entity: it.entity || undefined,
          topic: it.topic || undefined,
        })
      }

      // 收集 profiles
      for (const p of Object.values(s.profiles || {})) {
        const sc = p.scope || 'global'
        if (!byScope.has(sc)) byScope.set(sc, [])
        byScope.get(sc).push({
          id: `prof_${p.qq || 'unknown'}`,
          kind: 'profile',
          about: p.qq,
          aboutName: p.name,
          text: p.text,
          at: p.at,
        })
      }

      // 收集 insights
      for (const [key, list] of Object.entries(s.insights || {})) {
        const sc = personKeyToScope(key)
        if (!byScope.has(sc)) byScope.set(sc, [])
        for (const ins of list || []) {
          byScope.get(sc).push({
            id: ins.id,
            kind: 'insight',
            text: ins.text,
            at: ins.at,
          })
        }
      }

      // 收集 styles
      if (s.styles) {
        if (Array.isArray(s.styles.self) && s.styles.self.length > 0) {
          if (!byScope.has('global')) byScope.set('global', [])
          byScope.get('global').push({
            id: 'self',
            kind: 'style',
            text: JSON.stringify(s.styles.self),
          })
        }
        for (const [key, list] of Object.entries(s.styles)) {
          if (key === 'self') continue
          const sc = personKeyToScope(key)
          if (!byScope.has(sc)) byScope.set(sc, [])
          byScope.get(sc).push({
            id: `style_${key.replace(/\D/g, '') || 'custom'}`,
            kind: 'style',
            text: JSON.stringify(list),
          })
        }
      }

      // 收集 distill
      for (const [key, profile] of Object.entries(s.distill || {})) {
        // key 形如 "group:249729644#1040489623"
        const m = key.match(/^group:(\d+)#(\d+)$/)
        if (m) {
          const sc = `group:${m[1]}`
          if (!byScope.has(sc)) byScope.set(sc, [])
          byScope.get(sc).push({
            id: `distill_${m[2]}`,
            kind: 'distill-profile',
            about: m[1],
            sourceId: m[2],
            text: JSON.stringify(profile),
          })
        }
      }

      // 覆盖全部已知 scope（包括以前有、但本次被清空的 scope）
      const allScopes = new Set([...scopeSnapshots.keys(), ...byScope.keys()])
      for (const sc of allScopes) {
        const newEntries = byScope.get(sc) || []
        const oldSnap = scopeSnapshots.get(sc)
        const oldEntriesJson = oldSnap ? JSON.stringify(oldSnap.entries) : ''
        const newEntriesJson = JSON.stringify(newEntries)

        if (oldEntriesJson !== newEntriesJson) {
          commitScopeDocument(sc, newEntries, oldSnap?.prologue || '')
        }
      }

      return rev
    },

    close: () => {
      closed = true
      scopeSnapshots.clear()
    },

    reload: reloadAllScopes,

    stats: () => ({
      scopes: scopeSnapshots.size,
      items: assembleState().items.length,
      rev,
      dir: memoryDir,
    }),
  }
}
