// 显式离线迁移：停写旧库，校验暂存档案并备份源文件后再激活；已有目标不自动覆盖。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryFiles } from '../src/features/memory-files.js'
import { parseMarkdownArchive } from '../src/features/memory-markdown.js'

export function migrateToMarkdown(dataDir, { log = console } = {}) {
  const memoryDir = join(dataDir, 'memory')
  const migrationFile = join(memoryDir, 'migration.json')
  if (existsSync(memoryDir)) {
    let mig
    try { mig = JSON.parse(readFileSync(migrationFile, 'utf8')) } catch {}
    if (mig?.status !== 'success' || !existsSync(join(memoryDir, 'state.json'))) {
      throw new Error('Markdown 目标已存在且无有效迁移凭据；新旧数据可能冲突，请人工核对，禁止自动覆盖。')
    }
    const current = openMemoryFiles(memoryDir, { log })
    try {
      if (!current.health().ok) throw new Error('已迁移档案存在损坏，请修复并重载，不得重新迁移覆盖。')
    } finally { current.close() }
    log.info?.('[Migration] 记忆档案已完成向 Markdown 迁移，跳过。')
    return { ok: true, skipped: true, info: mig }
  }

  const dbPath = join(dataDir, 'memories.db')
  const metaPath = join(dataDir, 'memories.meta.json')
  const jsonPath = join(dataDir, 'memories.json')
  let rawItems = []
  let rawMeta = {}
  const sourceMode = existsSync(dbPath) ? 'sqlite' : existsSync(jsonPath) ? 'json' : 'empty'
  log.info?.(`[Migration] 开始迁移记忆数据，源格式: ${sourceMode}`)

  if (sourceMode === 'sqlite') {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare('SELECT * FROM items').all()
      for (const r of rows) {
        const tags = JSON.parse(r.tags || '[]')
        if (!Array.isArray(tags)) throw new Error(`条目 ${r.id} 的 tags 不是数组`)
        rawItems.push({
          id: r.id,
          text: r.text || '',
          about: r.about || '',
          aboutName: r.aboutName || '',
          importance: Number(r.importance || 0.5),
          source: r.source || 'tool',
          chatId: r.chatId || '',
          scope: r.scope || '',
          at: Number(r.at || 0),
          hits: Number(r.hits || 0),
          hitDays: Number(r.hitDays || 0),
          lastHit: Number(r.lastHit || 0),
          clarity: r.clarity || 'vivid',
          invalidAt: Number(r.invalidAt || 0),
          pinned: Number(r.pinned || 0),
          retention: Number(r.retention || 0),
          tags,
          supersededBy: r.supersededBy || undefined,
          ephemeral: r.ephemeral || undefined,
        })
      }
    } catch (err) {
      throw new Error(`读取旧 SQLite 数据库失败: ${err.message}`)
    } finally { db.close() }
    if (existsSync(metaPath)) {
      try {
        rawMeta = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) throw new Error('根节点必须是对象')
      } catch (err) {
        throw new Error(`读取 memories.meta.json 失败，中止迁移: ${err.message}`)
      }
    }
  } else if (sourceMode === 'json') {
    try {
      const obj = JSON.parse(readFileSync(jsonPath, 'utf8'))
      if (!obj || !Array.isArray(obj.items)) throw new Error('items 必须是数组')
      rawItems = obj.items
      rawMeta = obj
    } catch (err) {
      throw new Error(`读取旧 memories.json 失败: ${err.message}`)
    }
  }

  const cleanItems = []
  const quarantinedItems = []
  for (const it of rawItems) {
    const sc = String(it.scope || '').trim()
    if (!sc || sc === 'quarantine') quarantinedItems.push({ ...it, scope: 'quarantine' })
    else cleanItems.push({ ...it, scope: sc })
  }

  const stagingTag = Date.now()
  mkdirSync(dataDir, { recursive: true })
  const stagingDir = mkdtempSync(join(dataDir, 'memory.staging-'))
  const stagingStore = openMemoryFiles(stagingDir, { log })
  try {
    stagingStore.save({
      items: [...cleanItems, ...quarantinedItems],
      profiles: rawMeta.profiles || {},
      insights: rawMeta.insights || {},
      styles: rawMeta.styles || { self: [] },
      distill: rawMeta.distill || {},
      distillTargets: rawMeta.distillTargets || [],
      insightNames: rawMeta.insightNames || {},
      slang: rawMeta.slang || {},
      processed: rawMeta.processed || {},
      runs: rawMeta.runs || {},
      lastConsolidate: rawMeta.lastConsolidate || {},
    })
  } finally { stagingStore.close() }

  log.info?.('[Migration] 正在执行读回完整性比对...')
  const verifyStore = openMemoryFiles(stagingDir, { log })
  try {
    const verified = verifyStore.load()
    if (!verifyStore.health().ok) throw new Error('迁移校验失败：暂存档案损坏')
    if (verified.items.length !== cleanItems.length) {
      throw new Error(`迁移校验失败：有效原条目数 ${cleanItems.length}，迁移后活动条目数 ${verified.items.length}`)
    }
    const cleanIdMap = new Map(cleanItems.map((m) => [m.id, m]))
    for (const it of verified.items) {
      const orig = cleanIdMap.get(it.id)
      if (!orig || orig.text.trim() !== it.text.trim()) throw new Error(`迁移校验失败：条目 ${it.id} 正文不一致`)
    }
    if (quarantinedItems.length > 0) {
      const qFile = join(stagingDir, 'quarantine', 'memory.md')
      const parsed = parseMarkdownArchive(readFileSync(qFile, 'utf8'), { expectedScope: 'quarantine' })
      const originals = new Map(quarantinedItems.map((m) => [m.id, m]))
      if (parsed.entries.length !== quarantinedItems.length || parsed.entries.some((m) => originals.get(m.id)?.text.trim() !== m.text.trim())) {
        throw new Error('迁移校验失败：隔离区条目不符')
      }
    }
  } finally { verifyStore.close() }

  const backupDir = join(dataDir, 'backups', `pre-markdown-migration-${stagingTag}`)
  mkdirSync(backupDir, { recursive: true })
  for (const name of ['memories.db', 'memories.db-wal', 'memories.db-shm', 'memories.meta.json', 'memories.json']) {
    if (existsSync(join(dataDir, name))) copyFileSync(join(dataDir, name), join(backupDir, name))
  }
  const migrationRecord = {
    status: 'success',
    migratedAt: stagingTag,
    sourceMode,
    totalItems: rawItems.length,
    quarantinedCount: quarantinedItems.length,
    profilesCount: Object.keys(rawMeta.profiles || {}).length,
    distillCount: Object.keys(rawMeta.distill || {}).length,
  }
  writeFileSync(join(stagingDir, 'migration.json'), JSON.stringify(migrationRecord, null, 2), 'utf8')
  if (existsSync(memoryDir)) throw new Error('迁移期间目标目录已出现，存在并发写入或冲突；保留暂存目录，请人工核对。')
  renameSync(stagingDir, memoryDir)
  log.info?.(`[Migration] 迁移成功！共将 ${rawItems.length} 条记忆迁移至 Markdown 档案（隔离条目: ${quarantinedItems.length}）`)
  return { ok: true, record: migrationRecord }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-memory-markdown.js')) {
  const targetDir = process.argv[2] || process.env.AURABOT_DATA_DIR || process.env.DSH_QQ_HUB_DATA_DIR
  if (!targetDir) {
    console.error('请提供数据目录路径：node scripts/migrate-memory-markdown.js <dataDir>')
    process.exit(1)
  }
  try {
    console.log('迁移结果:', migrateToMarkdown(targetDir))
  } catch (err) {
    console.error('迁移失败:', err)
    process.exit(1)
  }
}
