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

/**
 * 解析模型挑资讯的输出。纯函数，方便测。
 * 模型偶尔会带 markdown 代码块或前后废话，所以只认第一个 JSON 数组。
 * @param {string} out 模型原始输出
 * @param {number} poolSize 候选池长度（序号越界要丢掉）
 * @param {number} want 最多要几条
 * @returns {Array<{index:number, say:string}>}
 */
export function parseDigestPick(out, poolSize, want) {
  const text = String(out || '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  let arr
  try { arr = JSON.parse(m[0]) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const picked = []
  const used = new Set()
  for (const x of arr) {
    const i = Number(x?.i) - 1
    const say = String(x?.say || '').trim()
    if (!Number.isInteger(i) || i < 0 || i >= poolSize) continue
    if (!say || used.has(i)) continue
    used.add(i)
    picked.push({ index: i, say: say.slice(0, 80) })
    if (picked.length >= Math.max(1, want)) break
  }
  return picked
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

    /** 每日精选：到点从池子里挑几条，让她用群友口气说出去（不是资讯播报）。 */
    async function digest({ manual = false } = {}) {
      const c = api.config().rss || {}
      const d = c.digest || {}
      if (!manual && d.enabled === false) return { ok: false, message: '每日精选没开' }
      const items = readPool(dir())
      if (!items.length) return { ok: false, message: '资讯池是空的，先去拉一次' }
      const st = readStatus()
      const readKeys = new Set((st.readKeys || []).slice(-3000))
      const sentKeys = new Set((st.digestKeys || []).slice(-3000))
      // 优先没发过的、没读过的
      let pool = items.filter((r) => !sentKeys.has(String(r.key)) && !readKeys.has(String(r.key)))
      if (!pool.length) pool = items.filter((r) => !sentKeys.has(String(r.key)))
      if (!pool.length) return { ok: false, message: '池子里的都发过了' }
      // 只把最近的 40 条交给模型挑（再多它也看不过来，白烧 token）
      pool = pool.slice().sort((a, b) => (Number(b.at) || Number(b.addedAt) || 0) - (Number(a.at) || Number(a.addedAt) || 0)).slice(0, 40)
      const want = Math.max(1, Math.min(6, Number(d.count) || 3))
      const brief = pool.map((r, i) => `${i + 1}. 【${r.feedTitle || '订阅'}】${r.title}｜${String(r.summary || '').slice(0, 120)}`).join('\n')
      let picked = []
      try {
        const out = await api.ask({
          system: `你是「大肥鱼」，一个混在 QQ 群里的 DeepSeek 猫娘（小鲸鱼）。现在帮自己从这批资讯里挑出今天最值得聊的 ${want} 条。\n`
            + '标准：有信息量、不平淡、群友会想接话；纯广告/软文/标题党不要。\n'
            + `每条用你自己的口气写一句「她会在群里说的那种话」（15~30 字）：像群友随口一提，不要播报腔、不要「首先」「值得关注」「强烈推荐」、不要复述摘要、不复述数字。\n`
            + '只输出 JSON 数组，形如 [{"i":序号,"say":"那句话"}]，不要别的字。',
          text: brief,
          maxTokens: 700,
          temperature: 0.8,
        })
        for (const x of parseDigestPick(out, pool.length, want)) {
          picked.push({ item: pool[x.index], say: x.say })
        }
      } catch (error) {
        api.log.warn('[rss] 精选时模型调用失败，退回按时间取前几条：', error.message)
      }
      // 模型没给出可用结果时兜底：直接取最新的几条，别让这个功能因为一次调用失败就哑掉
      if (!picked.length) picked = pool.slice(0, want).map((item) => ({ item, say: String(item.title || '').slice(0, 40) }))
      const lines = picked.map((p) => p.say).join('\n')
      const target = String(d.target || '').trim() || `private:${api.config().ownerQQ}`
      try {
        const chatId = /^(group|private):/.test(target) ? target : `private:${api.config().ownerQQ}`
        await api.core.hub.sendText(chatId, lines)
      } catch (error) {
        return { ok: false, message: '发不出去：' + error.message }
      }
      st.digestKeys = [...sentKeys, ...picked.map((p) => String(p.item.key))].slice(-3000)
      st.lastDigestAt = Date.now()
      st.lastDigestCount = picked.length
      writeStatus(st)
      api.log.info(`[rss] 每日精选发了 ${picked.length} 条 → ${target}`)
      return { ok: true, count: picked.length, text: lines }
    }

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

    // 每日精选：到点（默认早 9 点）从池子里挑几条发出去。
    // 用「今天发过没」判断，不靠固定间隔 —— 重启也不重复发、不会漏。
    api.every(60_000, () => {
      const s = (api.config().rss || {})
      const d = s.digest || {}
      if (!s.enabled || d.enabled === false) return
      const hour = Number(d.hour)
      const want = Number.isFinite(hour) ? hour : 9
      const now = new Date()
      if (now.getHours() !== want) return
      const st = readStatus()
      const today = now.toDateString()
      if (st.lastDigestDay === today) return // 今天已经发过
      st.lastDigestDay = today
      writeStatus(st)
      digest().catch((error) => api.log.warn('[rss] 每日精选出错：', error.message))
    }, '资讯池每日精选')

    // ---------- 她自己的工具 ----------
    api.tool(() => [api.defineTool({
      name: 'rss_read',
      description: '翻资讯池：订阅源拉回来的文章。群友问「有什么新鲜事」「最近有啥好玩的」、你想起个话题、想找点谈资时用。**可以说出来聊**：挑一条讲标题加一两句你自己的看法就够了；别整段照抄摘要、别一口气甩一堆链接（那是资讯机器人，不是群友）。',
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
        digest: {
          ...(api.config().rss?.digest || {}),
          lastAt: Number(st.lastDigestAt) || 0,
          lastCount: Number(st.lastDigestCount) || 0,
          lastDay: String(st.lastDigestDay || ''),
        },
        feeds: feedsOf().map((f) => ({
          ...f,
          title: st.feeds?.[f.id]?.title || f.title || '',
          lastAt: Number(st.feeds?.[f.id]?.at) || 0,
          error: String(st.feeds?.[f.id]?.error || ''),
        })),
      }
    })

    api.route('/rss/pull', async () => pull({ manual: true }))

    /** 面板「现在精选一次」：跳过排程直接跑（不跳过总开关）。 */
    api.route('/rss/digest-now', async () => digest({ manual: true }))

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