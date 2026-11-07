// SQLite（node:sqlite 内置，Node >= 22.5；宿主 24.22 实测可用）记忆存储层（P1-1）。
// 旧实现：每次 add/recall/profiles 都整读 541KB JSON + 整份重写（实测单次 add 13ms，3000 条会到 30ms+）。
// 新实现：单个 items 表 + WAL，读写都是增量；内存里保留一份全量镜像保证「面板接口路径不变」
// 和现有 indexFor/recall 逻辑零改动 —— load() 返回镜像，save(s) 算 diff 增量写库。
// 迁移：首次运行把 memories.json 一次性导入，原文件改名为 memories.json.pre-sqlite.bak（备份可回滚）。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ensureDir, writeJson } from '../core/store.js'
import { randomUUID } from 'node:crypto'

const COLS = ['id', 'text', 'about', 'aboutName', 'tags', 'importance', 'source', 'chatId', 'scope', 'at', 'hits', 'hitDays', 'lastHit', 'clarity', 'invalidAt', 'pinned', 'retention', 'embeddedAt']

function rowToItem(r) {
  const it = {}
  for (const c of COLS) it[c] = r[c]
  try { it.tags = JSON.parse(it.tags || '[]') } catch { it.tags = [] }
  it.importance = Number(it.importance)
  it.at = Number(it.at); it.hits = Number(it.hits || 0)
  return it
}

/** 打开/建库，返回 { db, load, save, close, stats }。dbPath 传 ':memory:' 用于测试。 */
export function openMemoryDb(dbPath, { log } = {}) {
  ensureDir(dirname(dbPath))
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', about TEXT DEFAULT '', aboutName TEXT DEFAULT '',
    tags TEXT DEFAULT '[]', importance REAL DEFAULT 0.5, source TEXT DEFAULT 'tool', chatId TEXT DEFAULT '',
    scope TEXT DEFAULT '', at INTEGER DEFAULT 0, hits INTEGER DEFAULT 0, hitDays INTEGER DEFAULT 0,
    lastHit INTEGER DEFAULT 0, clarity TEXT DEFAULT 'vivid', invalidAt INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0, retention REAL DEFAULT 0, embeddedAt INTEGER DEFAULT 0
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope)')
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')

  // 一次性迁移：老 memories.json 还在且没迁过 → 导入并备份
  const migrated = db.prepare("SELECT v FROM meta WHERE k='migratedAt'").get()
  const jsonPath = join(dirname(dbPath), 'memories.json')
  // 迁移失败时不能「嘴上说退回 JSON，实际拿着空库跑」——那样旧 memories.json 里的记忆
  // 看似全丢（实际在文件里，但本进程再也不读它）。这里直接把刚建的空库删掉，调用方
  // 捕获异常后退回 JSON 路径，行为和日志一致。
  let failed = false
  if (!migrated && existsSync(jsonPath)) {
    try {
      const old = JSON.parse(readFileSync(jsonPath, 'utf8'))
      const items = Array.isArray(old?.items) ? old.items : []
      const ins = db.prepare(`INSERT OR REPLACE INTO items (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
      let n = 0
      for (const it of items) {
        const row = COLS.map((c) => c === 'tags' ? JSON.stringify(it.tags || []) : (it[c] ?? (c === 'importance' ? 0.5 : c === 'at' ? Date.now() : c === 'id' ? randomUUID().slice(0, 8) : '')))
        ins.run(...row); n++
      }
      db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('migratedAt',?)").run(String(Date.now()))
      db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('migratedCount',?)").run(String(n))
      // 备份原文件（可回滚：改回名字即回到旧实现）
      try { renameSync(jsonPath, jsonPath + '.pre-sqlite.bak') } catch (error) { log?.warn?.('备份 memories.json 失败：', error.message) }
      log?.info?.(`记忆库：已把 ${n} 条记忆从 memories.json 迁移到 SQLite（原文件备份为 memories.json.pre-sqlite.bak）`)
    } catch (error) {
      log?.warn?.('记忆库迁移失败，退回 JSON 存储（数据库未启用）：', error.message)
      failed = true
    }
  }
  if (failed) {
    try { db.close() } catch {}
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix, { force: true }) } catch {} }
    throw new Error('记忆库迁移失败，已回退 JSON 存储')
  }

  // 内存镜像：load() 直接返回它，省掉每次全表读
  let items = db.prepare(`SELECT * FROM items`).all().map(rowToItem)
  let rev = Number(db.prepare("SELECT v FROM meta WHERE k='rev'").get()?.v || 1)
  // 附属结构（styles/insights/insightNames/profiles/lastConsolidate…）低频写、要整读整写，
  // 留在旁边的 JSON 里，不走 SQLite（items 高频才是瓶颈）。
  const sidecarPath = join(dirname(dbPath), 'memories.meta.json')
  // sidecar 读缓存：低频变（styles/insights/profiles），没必要每次 add 都读文件+parse。
  let sidecarCache = null
  let sidecarLoaded = false
  let lastSidecar = null
  const sidecarLoad = () => {
    if (sidecarLoaded) return sidecarCache
    try { sidecarCache = JSON.parse(readFileSync(sidecarPath, 'utf8')) } catch { sidecarCache = {} }
    sidecarLoaded = true
    return sidecarCache
  }
  const sidecarSave = (s) => {
    const skip = new Set(['items', 'rev'])
    const rest = {}
    for (const [k, v] of Object.entries(s || {})) if (!skip.has(k)) rest[k] = v
    const json = JSON.stringify(rest, null, 2)
    // 内容没变就不写盘：add 高频，而 sidecar（styles/insights/profiles）很少变。
    if (json === lastSidecar) return
    lastSidecar = json
    sidecarCache = rest
    sidecarLoaded = true
    // 走 store.js 的 tmp+fsync+rename 原子写：sidecar 里是人物小档案/相处经验/说话方式，
    // 写一半被 kill 再 parse 失败会整体静默清空，不能裸 writeFileSync（M1）。
    writeJson(sidecarPath, rest)
  }

  // 注意：items 必须深拷贝出去。如果泄漏闭包数组的引用，调用方（add 等）push 会直接改镜像，
  // 随后 save() 的 diff 会把新条目当成「旧值」全 skip，一条都写不进库（实测踩过）。
  const load = () => ({ ...sidecarLoad(), items: items.map((m) => ({ ...m, tags: [...(m.tags || [])] })), rev })

  const upsert = db.prepare(`INSERT OR REPLACE INTO items (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
  const del = db.prepare('DELETE FROM items WHERE id = ?')
  // add 高频路径：库几千条时全量 17 字段 diff 是最大开销（实测占 add 的 80%）。
  // 常变字段先行（text/at/hits/importance/clarity），全同才跳过；四个常变字段不同就不用比剩下的。
  const HOT_COLS = ['text', 'at', 'hits', 'importance', 'clarity']
  const eqCols = (a, b) => {
    for (const c of HOT_COLS) {
      if (String(a[c] ?? '') !== String(b[c] ?? '')) return false
    }
    for (const c of COLS) {
      if (c === 'tags') { if (JSON.stringify(a.tags || []) !== JSON.stringify(b.tags || [])) return false; continue }
      if (String(a[c] ?? '') !== String(b[c] ?? '')) return false
    }
    return true
  }

  // 落库快照（id 集合，仅配合删除路径清理），不再用 hash 快速跳过 ——
  // hash 只能编进部分字段，invalidate()（invalidAt）、update()（about/aboutName/tags）、
  // restore()（删 invalidAt/supersededBy）都会改 hash 看不见的字段，导致「面板改了/删了，
  // 重启又变回去」。全字段比较 3000 条也是微秒级，不值得为它冒丢字段的风险。
  const savedHash = new Map()

  function save(s) {
    const next = Array.isArray(s?.items) ? s.items : []
    sidecarSave(s)
    const oldById = new Map(items.map((m) => [m.id, m]))
    const nextIds = new Set(next.map((m) => m.id))
    let writes = 0
    for (const it of next) {
      const old = oldById.get(it.id)
      if (old && eqCols(old, it)) continue
      upsert.run(...COLS.map((c) => c === 'tags' ? JSON.stringify(it.tags || []) : (it[c] ?? '')))
      savedHash.set(it.id, 1)
      writes++
    }
    for (const m of items) if (!nextIds.has(m.id)) { del.run(m.id); savedHash.delete(m.id); writes++ }
    if (writes || next.length !== items.length) {
      rev = (Number(rev) || 0) + 1
      db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('rev',?)").run(String(rev))
    }
    items = next.map((m) => ({ ...m, tags: [...(m.tags || [])] }))
    return writes
  }

  return {
    db, load, save,
    close: () => { try { db.close() } catch {} },
    stats: () => ({ items: items.length, rev, file: dbPath }),
  }
}
