// 资讯池：把订阅源拉到的东西存下来，等她自己想起来查。
//
// 设计（主人 2026-11-04 定）：**只存池子，不主动推送**。
// 这个模块不往群里发任何东西 —— 推送会占 QQ 每分钟 10 条的配额（我们已经在限流边缘），
// 而且资讯机器人式的刷屏跟「群友感」是反的。她需要素材时自己调工具来查。
//
// 存储：<dataDir>/rss/pool.jsonl，一行一条，按加入时间追加。
// 去重：同一源同一个 key（guid / link / 标题）只留一条。
// 上限：条数超了就丢最老的（宁可少存，也不让文件无限长）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const POOL_VERSION = 1
export const POOL_DEFAULTS = Object.freeze({
  maxItems: 2000,        // 池子里最多留多少条
  maxBytes: 8 * 1024 * 1024, // 文件超过这个大小就压缩重写（去掉最老的）
})

/** @param {string} dir 数据目录（一般是 dataDir('rss')） */
export function poolFile(dir) {
  return join(dir, 'pool.jsonl')
}

function ensure(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch (error) {}
}

/** 读整个池子。坏行跳过，绝不因为一行脏数据就整个读不出来。 */
export function readPool(dir, { log } = {}) {
  const file = poolFile(dir)
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r && r.key) out.push(r)
      } catch (error) { /* 坏行跳过 */ }
    }
    return out
  } catch (error) {
    try { log?.debug?.('资讯池读取失败：', error.message) } catch {}
    return []
  }
}

/** 整池重写（去重 + 截断后调用）。原子写。 */
export function writePool(dir, items, { maxItems = POOL_DEFAULTS.maxItems } = {}) {
  ensure(dir)
  const file = poolFile(dir)
  const list = Array.isArray(items) ? items.slice(-maxItems) : []
  const body = list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : '')
  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
    return list.length
  } catch (error) {
    return -1
  }
}

/**
 * 把一批新条目并进池子（去重 + 截断）。
 * @param {string} dir
 * @param {Array} incoming 新条目
 * @param {{maxItems?:number, maxBytes?:number}} [opts]
 * @returns {{added:number, total:number}}
 */
export function mergeIntoPool(dir, incoming, { maxItems = POOL_DEFAULTS.maxItems, maxBytes = POOL_DEFAULTS.maxBytes } = {}) {
  ensure(dir)
  const existing = readPool(dir)
  const byKey = new Map()
  for (const r of existing) byKey.set(String(r.key), r)
  let added = 0
  for (const r of incoming || []) {
    if (!r || !r.key) continue
    const key = String(r.key)
    if (byKey.has(key)) continue // 已经有这条：不重复存
    byKey.set(key, { ...r, key, addedAt: Date.now() })
    added += 1
  }
  let list = [...byKey.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
  if (list.length > maxItems) list = list.slice(-maxItems)
  // 文件太大时也要瘦身（条数没超但每条都很长的源）
  let total = writePool(dir, list, { maxItems })
  try {
    if (existsSync(poolFile(dir)) && statSync(poolFile(dir)).size > maxBytes && list.length > 50) {
      list = list.slice(-Math.floor(list.length / 2))
      total = writePool(dir, list, { maxItems })
    }
  } catch (error) {}
  return { added, total }
}

/**
 * 从池子里查（她调工具时走这里）。
 * @param {Array} items
 * @param {{limit?:number, feedId?:string, keyword?:string, since?:number, unreadOnly?:boolean, readKeys?:Set<string>}} [q]
 */
export function queryPool(items, q = {}) {
  const limit = Math.max(1, Math.min(50, Number(q.limit) || 10))
  const kw = String(q.keyword || '').trim().toLowerCase()
  let list = Array.isArray(items) ? items : []
  if (q.feedId) list = list.filter((r) => String(r.feedId) === String(q.feedId))
  if (q.since) list = list.filter((r) => (Number(r.at) || Number(r.addedAt) || 0) >= Number(q.since))
  if (q.unreadOnly && q.readKeys) list = list.filter((r) => !q.readKeys.has(String(r.key)))
  if (kw) {
    const words = kw.split(/\s+/).filter(Boolean)
    list = list.filter((r) => {
      const hay = `${r.title || ''} ${r.summary || ''} ${r.feedTitle || ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }
  // 新的在前
  return list
    .slice()
    .sort((a, b) => (Number(b.at) || Number(b.addedAt) || 0) - (Number(a.at) || Number(a.addedAt) || 0))
    .slice(0, limit)
}

/** 池子概览（面板用）：每个源多少条、最新一条什么时候。 */
export function poolStats(items) {
  const byFeed = new Map()
  let newest = 0
  for (const r of items || []) {
    const id = String(r.feedId || '')
    if (!byFeed.has(id)) byFeed.set(id, { feedId: id, feedTitle: r.feedTitle || '', count: 0, newest: 0 })
    const b = byFeed.get(id)
    b.count += 1
    const t = Number(r.at) || Number(r.addedAt) || 0
    if (t > b.newest) b.newest = t
    if (t > newest) newest = t
  }
  return { total: (items || []).length, newest, feeds: [...byFeed.values()].sort((a, b) => b.count - a.count) }
}