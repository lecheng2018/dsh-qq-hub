// 一次性迁移脚本：将旧版 SQLite + memories.meta.json 无损迁移为 Markdown 档案（1.3.65 重构 A-03）。
//
// 规则：
//   1. 停写快照：只读提取旧 SQLite items 表和 memories.meta.json。
//   2. 写入暂存目录 memory.staging-<ts>，按 scope 生成各个 memory.md 与 state.json。
//   3. 全量读回校验，核对总条数、ID 集合、文本与隔离范围。
//   4. 校验通过后原子重命名为正式 memory/ 目录，写入 migration.json。
//   5. 无法确定 scope 的老旧记录归入 quarantine/memory.md，绝不盲目提升为 global。
//   6. 幂等：若已存在 migration.json 且 memory/ 完整则直接跳过，不重复迁移。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryFiles } from '../src/features/memory-files.js'
import { parseMarkdownArchive } from '../src/features/memory-markdown.js'

export function migrateToMarkdown(dataDir, { log = console } = {}) {
  const memoryDir = join(dataDir, 'memory')
  const migrationFile = join(memoryDir, 'migration.json')

  // 1. 幂等检查
  if (existsSync(migrationFile)) {
    try {
      const mig = JSON.parse(readFileSync(migrationFile, 'utf8'))
      if (mig.status === 'success') {
        log.info?.('[Migration] 记忆档案已完成向 Markdown 迁移，跳过。')
        return { ok: true, skipped: true, info: mig }
      }
    } catch {}
  }

  const dbPath = join(dataDir, 'memories.db')
  const metaPath = join(dataDir, 'memories.meta.json')
  const jsonPath = join(dataDir, 'memories.json')

  let rawItems = []
  let rawMeta = {}

  const sourceMode = existsSync(dbPath) ? 'sqlite' : existsSync(jsonPath) ? 'json' : 'empty'

  log.info?.(`[Migration] 开始迁移记忆数据，源格式: ${sourceMode}`)

  if (sourceMode === 'sqlite') {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare('SELECT * FROM items').all()
      for (const r of rows) {
        let tags = []
        try { tags = JSON.parse(r.tags || '[]') } catch {}
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
      db.close()
    } catch (err) {
      throw new Error(`读取旧 SQLite 数据库失败: ${err.message}`)
    }

    if (existsSync(metaPath)) {
      try {
        rawMeta = JSON.parse(readFileSync(metaPath, 'utf8'))
      } catch (err) {
        log.warn?.(`读取 memories.meta.json 失败，忽略附属元数据:`, err.message)
      }
    }
  } else if (sourceMode === 'json') {
    try {
      const obj = JSON.parse(readFileSync(jsonPath, 'utf8'))
      rawItems = Array.isArray(obj.items) ? obj.items : []
      rawMeta = obj
    } catch (err) {
      throw new Error(`读取旧 memories.json 失败: ${err.message}`)
    }
  }

  // 2. 隔离作用域安全清洗
  const cleanItems = []
  const quarantinedItems = []

  for (const it of rawItems) {
    const sc = String(it.scope || '').trim()
    if (!sc) {
      // 缺失作用域：归入隔离区，严禁提升为 global
      quarantinedItems.push({ ...it, scope: 'quarantine' })
    } else {
      cleanItems.push(it)
    }
  }

  // 3. 构建暂存目录
  const stagingTag = Date.now()
  const stagingDir = join(dataDir, `memory.staging-${stagingTag}`)
  mkdirSync(stagingDir, { recursive: true })

  const stagingStore = openMemoryFiles(stagingDir, { log })
  const combinedState = {
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
  }

  stagingStore.save(combinedState)
  stagingStore.close()

  // 4. 严格全量读回校验
  log.info?.(`[Migration] 正在执行读回完整性比对...`)
  const verifyStore = openMemoryFiles(stagingDir, { log })
  const verified = verifyStore.load()

  if (verified.items.length !== cleanItems.length) {
    throw new Error(`迁移校验失败：有效原条目数 ${cleanItems.length}，迁移后活动条目数 ${verified.items.length}`)
  }

  const cleanIdMap = new Map(cleanItems.map((m) => [m.id, m]))
  for (const it of verified.items) {
    const orig = cleanIdMap.get(it.id)
    if (!orig) {
      throw new Error(`迁移校验失败：发现未知条目 ID ${it.id}`)
    }
    if (orig.text.trim() !== it.text.trim()) {
      throw new Error(`迁移校验失败：条目 ${it.id} 正文不一致`)
    }
  }

  // 校验隔离区
  if (quarantinedItems.length > 0) {
    const qFile = join(stagingDir, 'quarantine', 'memory.md')
    if (!existsSync(qFile)) {
      throw new Error('迁移校验失败：未生成 quarantine/memory.md')
    }
    const qParsed = parseMarkdownArchive(readFileSync(qFile, 'utf8'), { expectedScope: 'quarantine' })
    if (qParsed.entries.length !== quarantinedItems.length) {
      throw new Error(`迁移校验失败：隔离区条目数不符`)
    }
  }
  verifyStore.close()

  // 5. 原子激活目标目录
  if (existsSync(memoryDir)) {
    // 若原目录存在（非成功标记残留），重命名备份
    renameSync(memoryDir, `${memoryDir}.bak-${stagingTag}`)
  }
  renameSync(stagingDir, memoryDir)

  // 6. 归档旧 SQLite 文件（保留副本供回滚）
  const backupDir = join(dataDir, 'backups', `pre-markdown-migration-${stagingTag}`)
  mkdirSync(backupDir, { recursive: true })
  if (existsSync(dbPath)) {
    try {
      copyFileSync(dbPath, join(backupDir, 'memories.db'))
      if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, join(backupDir, 'memories.db-wal'))
      if (existsSync(`${dbPath}-shm`)) copyFileSync(`${dbPath}-shm`, join(backupDir, 'memories.db-shm'))
      if (existsSync(metaPath)) copyFileSync(metaPath, join(backupDir, 'memories.meta.json'))
    } catch (err) {
      log.warn?.('[Migration] 备份旧数据库副本时遇到警告:', err.message)
    }
  }

  // 7. 写入迁移凭据与报告
  const migrationRecord = {
    status: 'success',
    migratedAt: stagingTag,
    sourceMode,
    totalItems: rawItems.length,
    quarantinedCount: quarantinedItems.length,
    profilesCount: Object.keys(rawMeta.profiles || {}).length,
    distillCount: Object.keys(rawMeta.distill || {}).length,
  }
  writeFileSync(join(memoryDir, 'migration.json'), JSON.stringify(migrationRecord, null, 2), 'utf8')

  log.info?.(`[Migration] 迁移成功！共将 ${rawItems.length} 条记忆完整迁移至 Markdown 档案（隔离条目: ${quarantinedItems.length}）`)
  return { ok: true, record: migrationRecord }
}

// 支持 CLI 直接执行：node scripts/migrate-memory-markdown.js [dataDir]
if (process.argv[1] && process.argv[1].endsWith('migrate-memory-markdown.js')) {
  const targetDir = process.argv[2] || process.env.AURABOT_DATA_DIR || process.env.DSH_QQ_HUB_DATA_DIR
  if (!targetDir) {
    console.error('请提供数据目录路径：node scripts/migrate-memory-markdown.js <dataDir>')
    process.exit(1)
  }
  try {
    const res = migrateToMarkdown(targetDir)
    console.log('迁移结果:', res)
  } catch (err) {
    console.error('迁移失败:', err)
    process.exit(1)
  }
}
