// 内置模块：资讯池（RSS / Atom 订阅源）。
//
// 主人 2026-11-04 定：**只存池子，不主动推送**。
// 推送会占 QQ 每分钟 10 条的配额（我们已经在限流边缘刷到 result=299），
// 而且资讯机器人式的刷屏跟「群友感」是反的。
// 她需要素材时自己调 `rss_read` 来查 —— 就像真人「刷到过什么」那样，想用才想起来。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFeed } from '../../rss/feed.js'
import { mergeIntoPool, poolStats, queryPool, readPool, writePool } from '../../rss/pool.js'
import { fetchAll, checkFeedUrl } from '../../rss/fetch.js'

const ID = 'rss'

/** 订阅源 id：从地址派生，稳定且能看出来是哪家。 */
function feedIdOf(url) {
  const s = String(url || '')
  let host = ''
  try { host = new URL(s).hostname.replace(/^www\./, '') } catch (error) { host = 'feed' }
  let h = 0
  for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return `${host}-${Math.abs(h).toString(36).slice(0, 6)}`
}

export default {
  id: ID,
  name: '资讯池',
  version: '1.0.0',
  api: 1,
  tab: 'rss',
  panel: 'panel.js',
  description: '把 RSS / Atom 订阅源拉下来存进池子，她需要素材时自己查（不主动推送）',
  setup(api) {
    const dir = () => {
      const d = api.dataDir()
      try { mkdirSync(d, { recursive: true }) } catch (error) {}
      return d
    }
    const statusFile = () => join(dir(), 'status.json')
    const readStatus = () => {
      try { return JSON.parse(readFileSync(statusFile(), 'utf8')) } catch (error) { return {} }
    }
    const writeStatus = (next) => {
      try { writeFileSync(statusFile(), JSON.stringify(next, null, 2)) } catch (error) {}
    }
    let pulling = false

    const feedsOf = () => {
      const s = (api.config().rss || {})
      const list = Array.isArray(s.feeds) ? s.feeds : []
      return list
        .map((f) => (typeof f === 'string' ? { url: f } : f))
        .filter((f) => f && f.url && f.enabled !== false)
        .map((f) => ({ id: feedIdOf(f.url), url: String(f.url), title: String(f.title || '') }))
    }

    /** 拉一遍所有源，结果并进池子。不推送任何消息。 */
    async function pull({ manual = false } = {}) {
      const s = (api.config().rss || {})
      if (!s.enabled && !manual) return { ok: false, message: '资讯池没开' }
      if (pulling) return { ok: false, message: '正在拉，稍等' }
      const feeds = feedsOf()
      if (!feeds.length) return { ok: false, message: '还没有配置订阅地址' }
      pulling = true
      const started = Date.now()
      const stat = readStatus()
      stat.feeds = stat.feeds && typeof stat.feeds === 'object' ? stat.feeds : {}
      const errs = []
      let addedTotal = 0
      try {
        const results = await fetchAll(feeds, {
          timeoutMs: 15000,
          onOne: (feed, r) => {
            stat.feeds[feed.id] = {
              url: feed.url,
              title: feed.title || stat.feeds[feed.id]?.title || '',
              at: Date.now(),
              ok: r.ok,
              error: r.ok ? '' : String(r.error || ''),
            }
          },
        })
        const incoming = []
        for (const r of results) {
          if (!r.ok) { errs.push(`${r.feed.url}：${r.error}`); continue }
          const parsed = parseFeed(r.text, { limit: Number(s.maxPerFeed) || 50, summaryChars: Number(s.summaryChars) || 400 })
          if (!parsed.ok) { errs.push(`${r.feed.url}：${parsed.error}`); continue }
          // 源自己报的标题比我们记的更可信
          if (parsed.title && stat.feeds[r.feed.id]) stat.feeds[r.feed.id].title = parsed.title
          const feedTitle = parsed.title || stat.feeds[r.feed.id]?.title || new URL(r.feed.url).hostname
          for (const it of parsed.items) {
            incoming.push({
              key: `${r.feed.id}|${it.key}`.slice(0, 300),
              feedId: r.feed.id,
              feedTitle,
              title: String(it.title || '').slice(0, 200),
              url: String(it.url || '').slice(0, 500),
              summary: String(it.summary || '').slice(0, Number(s.summaryChars) || 400),
              at: Number(it.at) || 0,
            })
          }
        }
        const merged = mergeIntoPool(dir(), incoming, { maxItems: Number(s.poolMaxItems) || 2000 })
        addedTotal = merged.added
        stat.lastPullAt = Date.now()
        stat.lastDurationMs = Date.now() - started
        stat.lastAdded = merged.added
        stat.poolTotal = merged.total
        stat.lastErrors = errs.slice(0, 10)
        writeStatus(stat)
        api.log.info(`[rss] 拉了 ${feeds.length} 个源，新增 ${merged.added} 条，池子共 ${merged.total} 条${errs.length ? `，${errs.length} 个源失败` : ''}`)
        return { ok: true, added: merged.added, total: merged.total, errors: errs }
      } catch (error) {
        api.log.warn('[rss] 拉取失败：', error.message)
        return { ok: false, message: error.message }
      } finally {
        pulling = false
      }
    }

    // 定时拉（模块关掉时 api.interval 不会跑）
    api.every(60_000, () => {
      const s = (api.config().rss || {})
      if (!s.enabled) return
      const st = readStatus()
      const gap = Math.max(5, Number(s.intervalMinutes) || 30) * 60_000
      if (Date.now() - (Number(st.lastPullAt) || 0) < gap) return
      pull().catch((error) => api.log.warn('[rss] 定时拉取出错：', error.message))
    }, '资讯池定时拉取')

    // ---------- 她自己的工具 ----------
    api.tool(() => [api.defineTool({
      name: 'rss_read',
      description: '翻资讯池：从订阅源拉回来的文章列表（标题+摘要+链接）。想找话题、找素材、看看最近有什么新鲜事时用。**只能你自己看**，别把整篇摘要复述进群。',
      properties: {
        limit: { type: 'number', description: '要几条，默认 8，最多 30' },
        keyword: { type: 'string', description: '只找标题或摘要里含这个词的（比如「AI」「显卡」）' },
        feedId: { type: 'string', description: '只看某个源（不确定就别填）' },
        unreadOnly: { type: 'boolean', description: '只看还没看过的（默认 true）' },
      },
      required: [],
      execute: async ({ limit, keyword, feedId, unreadOnly } = {}) => {
        const s = (api.config().rss || {})
        const items = readPool(dir())
        if (!items.length) return { ok: true, message: '资讯池是空的。可以让主人去面板配几个订阅地址。' }
        const readKeys = new Set((readStatus().readKeys || []).slice(-3000))
        const list = queryPool(items, {
          limit: Math.min(30, Math.max(1, Number(limit) || 8)),
          keyword: keyword || '',
          feedId: feedId || '',
          unreadOnly: unreadOnly !== false,
          readKeys,
        })
        if (!list.length) return { ok: true, message: '池子里没有符合条件的条目。' }
        // 看过就记下来，下次 unreadOnly 不会再给同一批
        const st = readStatus()
        const set = new Set([...(st.readKeys || []), ...list.map((r) => String(r.key))])
        st.readKeys = [...set].slice(-3000)
        writeStatus(st)
        const lines = list.map((r, i) => {
          const when = r.at ? new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
          return `${i + 1}. 【${r.feedTitle || '订阅'}】${r.title}${when ? `（${when}）` : ''}\n   ${r.summary || '（没摘要）'}\n   ${r.url || ''}`
        })
        return { ok: true, message: `池子里挑出 ${list.length} 条（共 ${items.length} 条）：\n\n${lines.join('\n\n')}`, count: list.length }
      },
    })])

    // ---------- 面板接口 ----------
    api.route('/rss/overview', () => {
      const s = (api.config().rss || {})
      const items = readPool(dir())
      const st = readStatus()
      return {
        ok: true,
        enabled: Boolean(s.enabled),
        intervalMinutes: Number(s.intervalMinutes) || 30,
        pool: poolStats(items),
        lastPullAt: Number(st.lastPullAt) || 0,
        lastAdded: Number(st.lastAdded) || 0,
        lastDurationMs: Number(st.lastDurationMs) || 0,
        lastErrors: Array.isArray(st.lastErrors) ? st.lastErrors : [],
        feeds: feedsOf().map((f) => ({
          ...f,
          title: st.feeds?.[f.id]?.title || f.title || '',
          lastAt: Number(st.feeds?.[f.id]?.at) || 0,
          error: String(st.feeds?.[f.id]?.error || ''),
        })),
      }
    })

    api.route('/rss/pull', async () => pull({ manual: true }))

    api.route('/rss/check', async (req) => {
      // 验证一个地址能不能拉（面板「添加前先测一下」）
      const q = (api.core?.http?.query?.(req) || {})
      const url = String(q.url || '')
      const check = checkFeedUrl(url)
      if (!check.ok) return { ok: false, message: check.error }
      const results = await fetchAll([{ id: 'probe', url: check.url }], { timeoutMs: 12000 })
      const r = results[0]
      if (!r || !r.ok) return { ok: false, message: r?.error || '拉不下来' }
      const parsed = parseFeed(r.text, { limit: 5 })
      if (!parsed.ok) return { ok: false, message: parsed.error }
      return { ok: true, title: parsed.title, count: parsed.items.length, sample: parsed.items.slice(0, 3).map((x) => x.title) }
    })

    api.route('/rss/clear', async () => {
      writePool(dir(), [], { maxItems: 0 })
      return { ok: true, message: '池子清了' }
    })

    return { pull, readStatus, poolStats: () => poolStats(readPool(dir())) }
  },
}

export { feedIdOf }