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
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { renameWithRetry, readJsonWithBackup, writeJsonWithBackup } from '../core/store.js'
import { parseMarkdownArchive, serializeMarkdownArchive, diffRoundTrip, MEMORY_FORMAT } from './memory-markdown.js'

export const MAX_SCOPE_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB 单文件硬守卫

/** 作用域对应的向量文件路径（1.4.4 向量通道）：与该作用域的 memory.md 同目录。 */
export function scopeToVecFilePath(scope) {
  return join(dirname(scopeToFilePath(scope)), 'vectors.bin')
}

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
    if (id === '.' || id === '..' || !/^[a-zA-Z0-9_\-\.]+$/.test(id)) {
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
  if (safeStr === '.' || safeStr === '..') throw new Error(`非法的作用域: "${s}"`)
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

let tmpTextSeq = 0

/**
 * 原子写入文本文件（写 tmp -> fsync -> rename）
 */
export function writeTextAtomic(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${++tmpTextSeq}`
  const fd = openSync(tmp, 'w', 0o644)
  // 同 store.js writeJson：fnOS 部署环境 umask 077 会把 mode 参数砍成 0o600，open 的 mode
  // 只是上限。没有这一步，memory.md 每次落盘都重新变成 Harness 私有，面板授权第二天失效。
  try { chmodSync(tmp, 0o644) } catch {}
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
  const brokenScopes = new Map()
  const emptyState = () => ({ version: 1, hits: {}, processed: {}, processedSources: {}, extractionBatches: {}, runs: {}, lastConsolidate: {}, insightNames: {} })
  const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const validState = (v) => isRecord(v)
    && ['hits', 'processed', 'processedSources', 'extractionBatches', 'runs', 'lastConsolidate', 'insightNames'].every((key) => v[key] === undefined || isRecord(v[key]))
    && Object.values(v.processed || {}).every((n) => Number.isSafeInteger(n) && n >= 0)
    && Object.values(v.processedSources || {}).every((source) => isRecord(source)
      && Number.isSafeInteger(source.count) && source.count >= 0
      && typeof source.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint))
  let stateSnapshot = emptyState()
  let stateError = null
  let stateRaw = null
  let lastStateMergeWarnAt = 0
  const STATE_MERGE_WARN_INTERVAL_MS = 60_000

  function parseValidDiskState(raw) {
    if (typeof raw !== 'string') return null
    try {
      const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const parsed = JSON.parse(clean)
      if (!validState(parsed)) return null
      return { ...emptyState(), ...parsed }
    } catch {
      return null
    }
  }

  function mergeRecordDelta(prevMap, diskMap, callerMap) {
    if (!isRecord(callerMap)) return diskMap
    const prev = isRecord(prevMap) ? prevMap : {}
    const merged = structuredClone(isRecord(diskMap) ? diskMap : {})
    for (const k of Object.keys(prev)) {
      if (!(k in callerMap) && JSON.stringify(merged[k]) === JSON.stringify(prev[k])) {
        delete merged[k]
      }
    }
    for (const [k, v] of Object.entries(callerMap)) {
      if (!(k in prev) || JSON.stringify(v) !== JSON.stringify(prev[k])) {
        merged[k] = v
      }
    }
    return merged
  }

  function reloadAllScopes() {
    if (closed) throw new Error('记忆存储已关闭')
    const recovered = readJsonWithBackup(stateFile, { fallback: emptyState, validate: validState, label: '记忆运行状态', onError: (err) => log.warn?.(err.message) })
    stateError = recovered.error?.message || null
    if (!existsSync(stateFile) && readdirSync(memoryDir).some((name) => /^state\.json(?:\.bak)?\.corrupt-/.test(name))) {
      stateError ||= '记忆运行状态缺失且存在损坏原件，请修复 state.json 后重载'
    }
    stateSnapshot = { ...emptyState(), ...recovered.value }
    stateRaw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
    scopeSnapshots.clear()
    brokenScopes.clear()
    const mdFiles = scanMemoryFiles(memoryDir)
    for (const file of mdFiles) {
      try {
        const raw = readFileSync(file, 'utf8')
        const parsed = parseMarkdownArchive(raw)
        const scope = parsed.meta.scope
        if (join(memoryDir, scopeToFilePath(scope)) !== file) throw new Error(`作用域 ${scope} 与档案路径不匹配`)
        if (scopeSnapshots.has(scope)) throw new Error(`重复的作用域 ${scope}`)
        scopeSnapshots.set(scope, {
          rawText: raw,
          entries: parsed.entries,
          prologue: parsed.prologue,
          file,
        })
      } catch (err) {
        brokenScopes.set(file, { file, error: err.message })
        log.error?.(`解析记忆文档失败: ${file}:`, err.message)
      }
    }
    rev++
  }

  function health() {
    return { ok: !stateError && brokenScopes.size === 0, stateError, brokenScopes: [...brokenScopes.values()] }
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
    const styleSources = {}

    const hitsMap = stateSnapshot.hits || {}

    for (const [scope, snap] of scopeSnapshots) {
      for (const e of snap.entries) {
        const kind = e.kind || 'fact'
        const isArchiveItem = kind === 'fact' || e.importance !== undefined || e.source !== undefined

        if (isArchiveItem) {
          const hitInfo = hitsMap[e.id] || {}
          items.push({
            id: e.id,
            text: e.text || '',
            kind: e.kind || 'fact',
            personaId: e.personaId || undefined,
            selfView: e.selfView || undefined,
            perspective: e.perspective || undefined,
            about: e.about || '',
            aboutName: e.aboutName || '',
            // tags / history 是**数组**，必须复制：过去 load() 靠外层 structuredClone 兜住，
            // 现在 load() 不再深拷贝（为了性能），共享 has 的话调用方 `listFor(...)[0].tags.push(x)`
            // 就会原地改到 scopeSnapshots 里的条目 —— 等于污染内存快照，写盘后还会变成脏数据。
            tags: Array.isArray(e.tags) ? e.tags.slice() : [],
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
            history: Array.isArray(e.history) ? e.history.map((h) => (h && typeof h === 'object' ? { ...h } : h)) : undefined,
            ephemeral: e.ephemeral ? 1 : undefined,
            title: e.title || undefined,
            evidence: e.evidence || undefined,
            revision: e.revision || undefined,
            // 传闻归因（上游 607090a 语义）：谁说的 / direct|hearsay|guess，缺省 direct 不落字段
            speaker: e.speaker || undefined,
            status: e.status || undefined,
          })
        } else if (kind === 'profile') {
          const key = `${e.about || ''}@${scope}`
          profiles[key] = {
            name: e.aboutName || '',
            qq: e.about || '',
            scope: scope,
            text: e.text || '',
            at: typeof e.at === 'number' ? e.at : Date.now(),
            origin: e.origin || undefined,
            sourceFactIds: Array.isArray(e.sourceFactIds) ? e.sourceFactIds.slice() : undefined,
            sourceRev: e.sourceRev || undefined,
            stale: e.stale || undefined,
            staleAt: e.staleAt || undefined,
            staleReason: e.staleReason || undefined,
            personaId: e.personaId || undefined,
          }
        } else if (kind === 'insight') {
          // 还原 memory.js 期望的键名：私聊对应 qq:<uid>，群聊对应 group:<gid>
          const insKey = scope.startsWith('private:') ? `qq:${scope.slice(8)}` : scope
          insights[insKey] = insights[insKey] || []
          insights[insKey].push({
            id: e.id,
            text: e.text || '',
            at: typeof e.at === 'number' ? e.at : Date.now(),
            origin: e.origin || undefined,
            sourceFingerprint: e.sourceFingerprint || undefined,
            sourceRev: e.sourceRev || undefined,
            stale: e.stale || undefined,
            staleAt: e.staleAt || undefined,
            personaId: e.personaId || undefined,
          })
        } else if (kind === 'style') {
          if (scope === 'global' && e.id === 'self') {
            styleSources.self = { origin: e.origin || undefined, sourceFingerprint: e.sourceFingerprint || undefined, sourceRev: e.sourceRev || undefined, stale: e.stale || undefined, staleAt: e.staleAt || undefined, personaId: e.personaId || undefined }
            try {
              styles.self = JSON.parse(e.text || '[]')
            } catch {
              styles.self = e.text ? e.text.split('\n').filter(Boolean) : []
            }
          } else {
            const styKey = scope.startsWith('private:') ? `qq:${scope.slice(8)}` : scope
            styleSources[styKey] = { origin: e.origin || undefined, sourceFingerprint: e.sourceFingerprint || undefined, sourceRev: e.sourceRev || undefined, stale: e.stale || undefined, staleAt: e.staleAt || undefined, personaId: e.personaId || undefined }
            styles[styKey] = styles[styKey] || []
            try {
              const list = JSON.parse(e.text || '[]')
              if (Array.isArray(list)) styles[styKey].push(...list)
              else styles[styKey].push(e.text)
            } catch {
              styles[styKey].push(e.text)
            }
          }
        }
      }
    }

    // 运行状态字段是 stateSnapshot 的**共享引用**：调用方改它就会污染内存快照。
    // 这里一律浅拷贝一层（这几个都是普通对象，浅拷贝足够：调用方只会整体替换 map/字段，
    // 不会深改某个值的内部结构）。这样 load() 就不必再对整个条目数组做 structuredClone ——
    // 上面 items/profiles/insights/... 每个元素本来就是新建对象，深拷贝 815 条纯属白花
    // 4.9ms/次，而 load() 是每轮聊天 + 每条群消息都要走的固定税。
    const shallow = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : (v || {}))
    const lastConsolidate = shallow(stateSnapshot.lastConsolidate)
    if (lastConsolidate.retry && typeof lastConsolidate.retry === 'object') {
      lastConsolidate.retry = { ...lastConsolidate.retry }
    }
    return {
      items,
      profiles,
      insights,
      styles,
      styleSources,
      insightNames: shallow(stateSnapshot.insightNames),
      processed: shallow(stateSnapshot.processed),
      processedSources: shallow(stateSnapshot.processedSources),
      extractionBatches: shallow(stateSnapshot.extractionBatches),
      runs: shallow(stateSnapshot.runs),
      lastConsolidate,
      rev,
    }
  }


  /**
   * 审计 S13：写盘前做一次「往返自检」——序列化后再解析回来，逐条比对内容字段。
   *
   * 过去这里只 `parseMarkdownArchive(rawText)` 确认「能解析」，不对账字段：正文里
   * 出现结构行时内容会被搬走甚至整段消失，而写盘照常成功，读回来才发现记忆少了。
   * 记忆是长期事实源，这种静默损坏比报错严重得多。
   *
   * 比对逻辑放在 memory-markdown 的 diffRoundTrip（纯函数、可单测）；
   * 这里只负责在发现差异时拒绝写入。
   */
  function assertRoundTrip(parsed, entries, scope) {
    const problems = diffRoundTrip(parsed.entries, entries)
    if (!problems.length) return
    throw new Error(
      `记忆档案往返自检失败（作用域 ${scope}），已阻止写入以免丢失内容：`
      + problems.slice(0, 5).join('；')
      + (problems.length > 5 ? `；另 ${problems.length - 5} 条` : ''),
    )
  }

  function prepareScopeDocument(scope, entries, prologue = '') {
    const file = join(memoryDir, scopeToFilePath(scope))
    if (brokenScopes.has(file)) throw new Error(`记忆档案损坏: ${file}；请修复后重载档案`)
    const previous = scopeSnapshots.get(scope)
    const diskRaw = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (diskRaw !== (previous?.rawText ?? null)) {
      throw new Error(`作用域 ${scope} 的档案已在外部被修改、删除或新增，请先重载档案`)
    }
    const rawText = entries.length || prologue.trim() ? serializeMarkdownArchive({ meta: { format: MEMORY_FORMAT, scope }, entries, prologue }) : null
    if (rawText && Buffer.byteLength(rawText, 'utf8') > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`记忆档案超限: 作用域 ${scope} 大小超过 ${MAX_SCOPE_FILE_BYTES / 1024 / 1024} MiB 上限，已阻止写入`)
    }
    if (rawText) {
      const parsed = parseMarkdownArchive(rawText, { expectedScope: scope })
      // 审计 S13：不再只确认「能解析」，而是确认「能原样还原」。
      assertRoundTrip(parsed, entries, scope)
    }
    return { scope, file, rawText, entries, prologue }
  }

  function commitScopeDocument(doc) {
    if (doc.rawText === null) {
      if (existsSync(doc.file)) unlinkSync(doc.file)
      scopeSnapshots.delete(doc.scope)
    } else {
      writeTextAtomic(doc.file, doc.rawText)
      scopeSnapshots.set(doc.scope, doc)
    }
    rev++
  }

  function commitState(next) {
    try {
      writeJsonWithBackup(stateFile, next, { validate: validState, label: '记忆运行状态', onError: (err) => log.warn?.(err.message) })
      stateSnapshot = next
      stateRaw = readFileSync(stateFile, 'utf8')
    } catch (error) {
      // 若主文件已落盘且合法，立刻同步内存镜像，避免后续所有保存因 stateRaw 失步陷入死锁
      try {
        if (existsSync(stateFile)) {
          const diskRaw = readFileSync(stateFile, 'utf8')
          const diskObj = parseValidDiskState(diskRaw)
          if (diskObj) {
            stateSnapshot = diskObj
            stateRaw = diskRaw
          }
        }
      } catch {}
      throw error
    }
  }

  return {
    load: () => {
      if (closed) throw new Error('记忆存储已关闭')
      // 不再 structuredClone：assembleState() 产出的 items/profiles/insights/... 全是新建对象，
      // 运行状态字段在 assembleState 里已做浅拷贝。深拷贝 815 条要 4.9ms，而 load() 是
      // indexFor / topicScore / recall / contextFor 的共同入口，每轮聊天与每条群消息都要付。
      return assembleState()
    },

    /** 轻量版本号：只读内存 rev，不构造 items（indexFor 的缓存判定用它，避免整库物化）。 */
    rev: () => {
      if (closed) throw new Error('记忆存储已关闭')
      return rev
    },

    save: (s) => {
      if (closed) throw new Error('记忆存储已关闭')
      if (stateError) throw new Error(`记忆运行状态不可用: ${stateError}`)
      const diskStateRaw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
      const prevBase = stateSnapshot
      let baseState = stateSnapshot
      let mergedExternal = false
      if (diskStateRaw !== stateRaw) {
        // state.json 是纯机器运行态（与用户可手改的 memory.md 区分）：
        // 若磁盘 state.json 经 validState 校验合法，自动重载并合并当前运行态增量，不再永久砖化；
        // 仅当磁盘 state.json 缺失、损坏或结构非法时才抛错。
        const diskState = parseValidDiskState(diskStateRaw)
        if (!diskState) {
          throw new Error('记忆运行状态已在外部被修改，请先重载档案')
        }
        baseState = diskState
        mergedExternal = true
        const nowWarn = Date.now()
        if (nowWarn - lastStateMergeWarnAt >= STATE_MERGE_WARN_INTERVAL_MS) {
          lastStateMergeWarnAt = nowWarn
          log.warn?.('记忆运行状态 state.json 在外部发生合法变更，已自动重载并合并当前运行态增量')
        }
      }
      s = structuredClone(s)
      const stateChanges = {}
      const recordKeys = ['insightNames', 'processed', 'processedSources', 'extractionBatches', 'runs']
      for (const key of recordKeys) {
        if (!s[key]) continue
        stateChanges[key] = mergedExternal
          ? mergeRecordDelta(prevBase[key], baseState[key], s[key])
          : s[key]
      }
      if (s.lastConsolidate) {
        if (!mergedExternal || JSON.stringify(s.lastConsolidate) !== JSON.stringify(prevBase.lastConsolidate || {})) {
          stateChanges.lastConsolidate = s.lastConsolidate
        }
      }

      const hitsMap = structuredClone(baseState.hits || {})
      let hitsChanged = false
      for (const it of s.items || []) {
        if (it.hits || it.lastHit || it.hitDays) {
          const old = (prevBase.hits || {})[it.id]
          const callerChanged = !old || old.hits !== it.hits || old.lastHit !== it.lastHit || old.hitDays !== it.hitDays
          if (!mergedExternal) {
            if (callerChanged) {
              hitsMap[it.id] = { hits: it.hits, lastHit: it.lastHit, hitDays: it.hitDays }
              hitsChanged = true
            }
          } else if (callerChanged) {
            const curDisk = hitsMap[it.id]
            if (curDisk) {
              const dHits = Math.max(0, (Number(it.hits) || 0) - (Number(old?.hits) || 0))
              const dDays = Math.max(0, (Number(it.hitDays) || 0) - (Number(old?.hitDays) || 0))
              hitsMap[it.id] = {
                hits: dHits > 0 ? (Number(curDisk.hits) || 0) + dHits : Math.max(Number(curDisk.hits) || 0, Number(it.hits) || 0),
                hitDays: dDays > 0 ? (Number(curDisk.hitDays) || 0) + dDays : Math.max(Number(curDisk.hitDays) || 0, Number(it.hitDays) || 0),
                lastHit: Math.max(Number(curDisk.lastHit) || 0, Number(it.lastHit) || 0),
              }
            } else {
              hitsMap[it.id] = { hits: it.hits, lastHit: it.lastHit, hitDays: it.hitDays }
            }
            hitsChanged = true
          }
        }
      }
      if (hitsChanged || mergedExternal) stateChanges.hits = hitsMap
      const nextState = { ...baseState, ...stateChanges, updatedAt: Date.now() }
      if (!validState(nextState)) throw new Error('记忆运行状态结构不符合预期，拒绝写入')

      const byScope = new Map()
      for (const it of s.items || []) {
        if (!it.scope) throw new Error(`记忆 ${it.id} 缺少作用域 scope，拒绝提升为 global`)
        const sc = it.scope
        if (!byScope.has(sc)) byScope.set(sc, [])
        byScope.get(sc).push({
          id: it.id,
          kind: it.kind || 'fact',
          personaId: it.personaId || undefined,
          selfView: it.selfView ? true : undefined,
          perspective: it.perspective || undefined,
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
          speaker: it.speaker || undefined,
          status: it.status || undefined,
        })
      }

      // 收集 profiles
      for (const p of Object.values(s.profiles || {})) {
        const sc = p.scope || 'global'
        if (!byScope.has(sc)) byScope.set(sc, [])
        byScope.get(sc).push({
          // T3.8：档案 ID 必须带人设分桶 —— 同一 QQ 在不同人设下的档案是两份独立记忆，
          // 共用 `prof_<qq>` 会互相覆写（人设 B 的档案把默认人设那份顶掉）。
          id: `prof_${String(p.personaId || p.persona || 'default').trim() || 'default'}_${p.qq || 'unknown'}`,
          kind: 'profile',
          about: p.qq,
          aboutName: p.name,
          text: p.text,
          at: p.at,
          origin: p.origin || undefined,
          sourceFactIds: p.sourceFactIds || undefined,
          sourceRev: p.sourceRev || undefined,
          stale: p.stale || undefined,
          staleAt: p.staleAt || undefined,
          staleReason: p.staleReason || undefined,
          personaId: p.personaId || undefined,
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
            origin: ins.origin || undefined,
            sourceFingerprint: ins.sourceFingerprint || undefined,
            sourceRev: ins.sourceRev || undefined,
            stale: ins.stale || undefined,
            staleAt: ins.staleAt || undefined,
            personaId: ins.personaId || undefined,
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
            origin: s.styleSources?.self?.origin || undefined,
            sourceFingerprint: s.styleSources?.self?.sourceFingerprint || undefined,
            sourceRev: s.styleSources?.self?.sourceRev || undefined,
            stale: s.styleSources?.self?.stale || undefined,
            staleAt: s.styleSources?.self?.staleAt || undefined,
            personaId: s.styleSources?.self?.personaId || undefined,
          })
        }
        for (const [key, list] of Object.entries(s.styles)) {
          if (key === 'self') continue
          if (!Array.isArray(list) || list.length === 0) continue
          const sc = personKeyToScope(key)
          if (!byScope.has(sc)) byScope.set(sc, [])
          const digits = key.replace(/\D/g, '')
          const safeId = digits || key.replace(/[^a-zA-Z0-9_-]/g, '_') || 'custom'
          byScope.get(sc).push({
            id: `style_${safeId}`,
            kind: 'style',
            text: JSON.stringify(list),
            origin: s.styleSources?.[key]?.origin || undefined,
            sourceFingerprint: s.styleSources?.[key]?.sourceFingerprint || undefined,
            sourceRev: s.styleSources?.[key]?.sourceRev || undefined,
            stale: s.styleSources?.[key]?.stale || undefined,
            staleAt: s.styleSources?.[key]?.staleAt || undefined,
            personaId: s.styleSources?.[key]?.personaId || undefined,
          })
        }
      }


      const allScopes = new Set([...scopeSnapshots.keys(), ...byScope.keys()])
      const pending = []
      const paths = new Set()
      for (const sc of allScopes) {
        const newEntries = byScope.get(sc) || []
        const oldSnap = scopeSnapshots.get(sc)
        const doc = prepareScopeDocument(sc, newEntries, oldSnap?.prologue || '')
        if (paths.has(doc.file)) throw new Error(`作用域路径冲突: ${sc}`)
        paths.add(doc.file)
        if (JSON.stringify(oldSnap?.entries) !== JSON.stringify(newEntries)) pending.push(doc)
      }
      for (const doc of pending) commitScopeDocument(doc)
      const currentStateRaw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
      if (currentStateRaw !== diskStateRaw) {
        throw new Error('记忆运行状态已在外部被修改，请先重载档案')
      }
      commitState(nextState)
      return rev
    },

    close: () => {
      closed = true
      scopeSnapshots.clear()
    },

    health,
    reload: reloadAllScopes,

    stats: () => ({
      scopes: scopeSnapshots.size,
      items: assembleState().items.length,
      rev,
      dir: memoryDir,
    }),
  }
}
