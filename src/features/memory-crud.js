// 记忆条目 CRUD：增删改查、批量合并去重、墓碑失效与恢复、配额淘汰、
// 召回负反馈降权（reportMiss）、主人换号迁移（reassignOwner）及统计。

import { randomUUID } from 'node:crypto'
import { withPersonaId, isSubjectiveEntry, effectivePersonaId } from './memory-persona-track.js'
import { TOTAL_CAP, contradicts, evictScopeItems, quotaForScope, search, similarity, tokenize } from './memory-core.js'
import { isValidScope } from './memory-scope.js'

const TAG_SPLIT_RE = /[,\s，、]+/
function normalizeTags(tags) {
  const raw = Array.isArray(tags)
    ? tags
    : (typeof tags === 'string' ? tags.split(TAG_SPLIT_RE) : [])
  return raw.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 5)
}

const MISS_RE = /(记错|不是这[个样]|谁跟你说的?|乱记|瞎记|胡说|没有?这回事|记岔|搞错|什么跟什么|不对吧|才不是)/

/**
 * 创建记忆条目 CRUD 处理器。
 */
export function createMemoryCrud({ getConfig, log, session, indexCache, derived, getRecalls, clearRecalls, vecStatusSafe }) {
  const { load, mutate, isClosed } = session
  const { activePersonaId, personaVisible, scopeOfChat, scopeFromChatId, scopeVisible, indexAll, tokOf, invalidateToken } = indexCache
  const { staleProfilesIn, clearDerivedForScope, personKey } = derived

  /** 作用域配额淘汰 + 全库兜底上限淘汰；quiet=true 时不打单作用域日志。 */
  function evictIfNeeded(s, scope, { quiet = false } = {}) {
    let total = 0
    const evictedItems = []
    // 作用域配额淘汰：超额则裁掉超额部分（绝不淘汰 pinned，优先淘汰已失效墓碑）
    const quota = quotaForScope(scope)
    const inScope = s.items.reduce((n, m) => n + (String(m.scope || '') === String(scope) ? 1 : 0), 0)
    if (inScope > quota) {
      const removed = evictScopeItems(s.items, scope, quota, Date.now(), evictedItems)
      if (removed > 0) {
        total += removed
        if (!quiet) log?.info?.(`记忆库：${scope} 超出配额 ${quota} 条，淘汰了 ${removed} 条最不重要的`)
      }
    }
    // 全库兜底上限：防极端情况（大量小作用域）无限涨（同样绝不淘汰 pinned，优先淘汰墓碑）
    if (s.items.length > TOTAL_CAP) {
      const eligible = s.items.filter((m) => !m.pinned)
      const victims = eligible
        .slice()
        .sort((a, b) =>
          ((Number(b.invalidAt) > 0 ? 1 : 0) - (Number(a.invalidAt) > 0 ? 1 : 0))
          || (Number(a.importance ?? 0.5) - Number(b.importance ?? 0.5))
          || ((b.source === 'auto' ? 1 : 0) - (a.source === 'auto' ? 1 : 0))
          || (Number(a.at || 0) - Number(b.at || 0)))
        .slice(0, s.items.length - TOTAL_CAP)
        .map((m) => m.id)
      const kill = new Set(victims)
      let n = 0
      for (let i = s.items.length - 1; i >= 0; i--) {
        if (kill.has(s.items[i].id)) {
          const [gone] = s.items.splice(i, 1)
          evictedItems.push(gone)
          n++
        }
      }
      if (n > 0) {
        total += n
        if (!quiet) log?.info?.(`记忆库：全库超过兜底上限 ${TOTAL_CAP} 条，淘汰 ${n} 条`)
      }
    }
    // 被淘汰条目的派生缓存必须同步失效，否则小档案/切词缓存会一直引用已删除的记忆
    if (evictedItems.length) {
      const stalePairs = new Set()
      for (const gone of evictedItems) {
        if (!gone) continue
        invalidateToken(gone.id)
        if (!gone.about) continue
        const pair = `${gone.about}@${gone.scope || ''}`
        if (stalePairs.has(pair)) continue
        stalePairs.add(pair)
        staleProfilesIn(s, String(gone.about), String(gone.scope || ''))
      }
    }
    return total
  }

  /**
   * add() 的纯内存部分：校验 + 归一 + 去重合并 + push，不落盘。
   */
  function applyAdd(s, entry = {}, { evict = true } = {}) {
    const {
      text, about = '', aboutName = '', tags = [], importance = 0.5,
      source = 'tool', sourceId = '', chatId = '', scope = '',
      ephemeral = false, pinned = false, entity = '', topic = '',
      evidence = '', title = '', personaId = '',
      kind: rawKind, selfView, perspective,
      speaker = '', status: entryStatus = '',
    } = entry
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }

    const ownerQQ = String(getConfig()?.ownerQQ || '')
    const finalScope = String(scope || '').trim() || scopeFromChatId(chatId) || (ownerQQ ? `private:${ownerQQ}` : 'global')
    if (!isValidScope(finalScope)) {
      return { ok: false, message: `作用域不合法：${finalScope}（只接受 global / private:<QQ> / group:<群号>）` }
    }

    const isSubjective = Boolean(
      (rawKind && rawKind !== 'fact') ||
      selfView ||
      perspective === 'self' ||
      personaId,
    )
    const kind = rawKind || (isSubjective ? 'insight' : 'fact')

    const item = {
      id: randomUUID().slice(0, 8),
      text: t,
      kind,
      selfView: Boolean(selfView || (isSubjective && rawKind !== 'style' && rawKind !== 'profile')),
      perspective: perspective ? String(perspective) : (isSubjective ? 'self' : ''),
      about: String(about || ''),
      aboutName: String(aboutName || ''),
      tags: normalizeTags(tags),
      importance: Math.max(0, Math.min(1, Number(importance) || 0.5)),
      source,
      sourceId,
      chatId,
      scope: finalScope,
      at: Date.now(),
      hits: 0,
      clarity: 'vivid',
      ephemeral: ephemeral ? 1 : '',
      pinned: pinned ? 1 : 0,
      entity: String(entity || '').slice(0, 30),
      topic: String(topic || '').slice(0, 20),
      evidence: String(evidence || '').slice(0, 200),
      title: String(title || '').slice(0, 50),
      ...(String(speaker || '').trim() ? { speaker: String(speaker).trim().slice(0, 40) } : {}),
      ...(entryStatus === 'hearsay' || entryStatus === 'guess' ? { status: entryStatus } : {}),
      ...(personaId ? { personaId: String(personaId).trim() } : {}),
    }

    const activePersona = activePersonaId(finalScope)
    const normalizedItem = withPersonaId(item, activePersona)

    const scopeGuess = finalScope
    const scopeItems = s.items.filter((m) => String(m.scope || '') === scopeGuess)
    const tToks = new Set(tokenize(t))
    const maybe = (m) => {
      if (m.invalidAt) return false
      if (!about || !m.about || m.about === String(about)) {
        for (const w of tokOf(m)) if (tToks.has(w)) return true
      }
      return false
    }

    const itemIsSub = isSubjectiveEntry(normalizedItem)
    const itemPid = effectivePersonaId(normalizedItem, activePersona)
    const samePersonaTrack = (m) => {
      const mSub = isSubjectiveEntry(m)
      if (!itemIsSub && !mSub) return true
      if (itemIsSub !== mSub) return false
      return effectivePersonaId(m, activePersona) === itemPid
    }

    const hasBiliTag = (tagList) => {
      const arr = Array.isArray(tagList)
        ? tagList
        : (typeof tagList === 'string' ? tagList.split(TAG_SPLIT_RE) : [])
      return arr.some((tag) => String(tag ?? '').trim() === 'B站')
    }
    const isBiliEntry = (textVal, tagList) => String(textVal || '').includes('B站') || hasBiliTag(tagList)
    const entryIsBili = isBiliEntry(t, item.tags)
    const dup = scopeItems.find((m) => {
      const dupAt = (entryIsBili || isBiliEntry(m.text, m.tags)) ? 0.5 : 0.6
      return maybe(m) && samePersonaTrack(m) && similarity(m.text, t) >= dupAt
        && !contradicts(t, m.text, String(about || ''), String(m.about || ''), scopeGuess, String(m.scope || ''))
    })
    if (dup) {
      const textReplaced = t.length >= dup.text.length && t !== dup.text
      if (t.length >= dup.text.length) dup.text = t
      // 正文被覆盖时必须让切词缓存失效，否则下一次去重还在用旧正文的切词
      if (textReplaced) invalidateToken(dup.id)
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      if (evidence) dup.evidence = String(evidence).slice(0, 200)
      if (entity) dup.entity = String(entity).slice(0, 30)
      if (topic) dup.topic = String(topic).slice(0, 20)
      if (pinned) dup.pinned = 1
      // 来源归因合并：绝不让 guess/hearsay 反向降级已确认的 direct 记忆；
      // 仅当原条目非 direct，或正文被非降级事实覆盖时更新 status/speaker。
      const dupIsDirect = !dup.status || dup.status === 'direct'
      const incomingIsDowngrade = entryStatus === 'hearsay' || entryStatus === 'guess'
      if (!dupIsDirect) {
        if (incomingIsDowngrade) {
          dup.status = entryStatus
          if (String(speaker || '').trim()) dup.speaker = String(speaker).trim().slice(0, 40)
        } else {
          delete dup.status
          if (String(speaker || '').trim()) dup.speaker = String(speaker).trim().slice(0, 40)
        }
      } else if (textReplaced && !incomingIsDowngrade) {
        if (String(speaker || '').trim()) dup.speaker = String(speaker).trim().slice(0, 40)
      }
      staleProfilesIn(s, String(dup.about || ''), String(dup.scope || ''))
      return { ok: true, message: '✓', updated: dup.id, deduped: true, scope: finalScope }
    }

    s.items.push(normalizedItem)
    if (evict && s.items.length > quotaForScope(finalScope)) evictIfNeeded(s, finalScope)
    staleProfilesIn(s, String(about || ''), finalScope, { reason: 'append' })
    return { ok: true, message: '✓', id: normalizedItem.id, scope: finalScope }
  }

  function add(entry = {}) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    return mutate((s, abort) => {
      const r = applyAdd(s, entry)
      if (!r.ok) return abort(r)
      s.rev = (s.rev || 0) + 1
      return { ok: true, message: '✓', ...(r.updated ? { updated: r.updated } : { id: r.id }) }
    })
  }

  function addMany(entries) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭', added: 0, updated: 0, skipped: 0 }
    const list = Array.isArray(entries) ? entries : []
    return mutate((s, abort) => {
      const touchedScopes = new Set()
      let added = 0
      let updated = 0
      let skipped = 0
      let rejected = null
      for (const entry of list) {
        const r = applyAdd(s, entry, { evict: false })
        if (!r.ok) {
          skipped++
          rejected ||= r.message
          continue
        }
        if (r.updated) updated++
        else added++
        if (r.scope) touchedScopes.add(r.scope)
      }
      if (!(added || updated)) {
        return abort({ ok: !rejected, message: rejected || '✓', added, updated, skipped })
      }
      let evicted = 0
      for (const sc of touchedScopes) evicted += evictIfNeeded(s, sc, { quiet: true })
      if (evicted > 0) log?.info?.(`记忆库：本批整理淘汰了 ${evicted} 条最不重要的（超出作用域配额或全库上限）`)
      s.rev = (s.rev || 0) + 1
      return { ok: !rejected, message: rejected || '✓', added, updated, skipped }
    })
  }

  function supersede({ oldId, text, about = '', aboutName = '', tags = [], importance, source = 'auto', sourceId = '', chatId = '', scope = '', evidence = '', entity = '', topic = '', title = '', speaker = '', status: entryStatus = '' }) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    const t = String(text || '').trim().slice(0, 200)
    return mutate((s, abort) => {
      const target = s.items.find((x) => x.id === oldId)
      if (!target) return abort({ ok: false, message: '未找到被替代的旧事实' })
      if (target.pinned) return abort({ ok: false, message: '手工固定的重要事实不能自动被替代' })

      const finalScope = String(scope || '').trim() || target.scope || scopeFromChatId(chatId)
      if (target.scope !== finalScope) {
        return abort({ ok: false, message: '不同作用域的事实不能互相替代' })
      }
      if (!t) return abort({ ok: false, message: '新事实内容为空' })

      const newId = randomUUID().slice(0, 8)
      const newItem = {
        id: newId,
        text: t,
        about: String(about || target.about || ''),
        aboutName: String(aboutName || target.aboutName || ''),
        tags: (() => {
          const nextTags = normalizeTags(tags)
          return nextTags.length ? nextTags : normalizeTags(target.tags)
        })(),
        importance: Math.max(0, Math.min(1, Number(importance ?? target.importance ?? 0.5))),
        source,
        sourceId,
        chatId: chatId || target.chatId || '',
        scope: finalScope,
        at: Date.now(),
        hits: 0,
        clarity: 'vivid',
        evidence: String(evidence || '').slice(0, 200),
        entity: String(entity || '').slice(0, 30),
        topic: String(topic || '').slice(0, 20),
        title: String(title || target.title || '').slice(0, 50),
        supersededFrom: target.id,
        ...(String(speaker || target.speaker || '').trim() ? { speaker: String(speaker || target.speaker).trim().slice(0, 40) } : {}),
        ...((entryStatus === 'hearsay' || entryStatus === 'guess') ? { status: entryStatus }
          : (target.status === 'hearsay' || target.status === 'guess') ? { status: target.status } : {}),
        ...(target.kind ? { kind: target.kind } : {}),
        ...(target.selfView ? { selfView: true } : {}),
        ...(target.perspective ? { perspective: target.perspective } : {}),
        ...(target.personaId ? { personaId: target.personaId } : {}),
      }

      target.invalidAt = Date.now()
      target.supersededBy = newId
      s.items.push(newItem)
      evictIfNeeded(s, finalScope)
      staleProfilesIn(s, String(target.about || ''), finalScope)
      s.rev = (s.rev || 0) + 1
      return { ok: true, id: newId, oldId: target.id, oldText: target.text }
    })
  }

  function supersedeWithLog(params) {
    const res = supersede(params)
    if (res.ok) {
      log?.info?.(`记忆替代（Supersede）：「${res.oldText}」已失效 → 「${String(params?.text || '').trim().slice(0, 200)}」[ID: ${res.id}]`)
      return { ok: true, id: res.id, oldId: res.oldId }
    }
    return res
  }

  function importCommit(items, { scope = 'private' } = {}) {
    const want = scope === 'global' ? 'global' : ''
    let n = 0
    for (const c of items || []) {
      if (add({ text: c.text, aboutName: c.aboutName || '', importance: c.importance ?? 0.5, source: 'import', ...(want ? { scope: want } : {}) }).id) n++
    }
    return n
  }

  function addEvent({ text, about = '', aboutName = '', tags = [], importance = 0.45, scope = '', chat = null, chatId = '', ephemeral = false, sourceId = '', evidence = '' }) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    const sc = String(scope || '').trim() || (chat ? scopeOfChat(chat) : scopeFromChatId(chatId))
    const ownerScope = String(getConfig()?.ownerQQ || '')
    const finalScope = sc === 'global' ? 'global' : sc || (ownerScope ? `private:${ownerScope}` : 'global')
    return add({ text, about, aboutName, tags: ['经历', ...tags], importance, source: 'event', sourceId, chatId: chatId || (chat && chat.chatId) || '', scope: finalScope, ephemeral, evidence })
  }

  function recentEvents(hours = 24, limit = 4, chat = null) {
    if (chat && chat.kind === 'group') return []
    const since = Date.now() - hours * 3600_000
    if (!chat) return []
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since)
      .filter((m) => scopeVisible(m.scope, chat) && personaVisible(m, chat))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  function listFor(scopes, { limit = 200 } = {}) {
    const want = [...(Array.isArray(scopes) ? scopes : scopes ? [scopes] : [])].map((x) => String(x ?? '').trim()).filter(Boolean)
    if (!want.length) return []
    const items = load().items.filter((m) => !m.invalidAt && want.includes(String(m.scope || '')) && personaVisible(m, m.scope))
    return items.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || b.at - a.at).slice(0, limit)
  }

  function recentEventsFor(scopes, hours = 24, limit = 4) {
    const want = new Set([...(Array.isArray(scopes) ? scopes : scopes ? [scopes] : [])].map((x) => String(x ?? '').trim()).filter(Boolean))
    if (!want.size) return []
    const since = Date.now() - hours * 3600_000
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since && want.has(String(m.scope || '')) && personaVisible(m, m.scope))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  function update(id, patch) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    return mutate((s, abort) => {
      const m = s.items.find((x) => x.id === id)
      if (!m) return abort({ ok: false, message: '没有这条' })
      for (const k of ['text', 'about', 'aboutName', 'tags', 'importance']) {
        if (patch[k] !== undefined) m[k] = patch[k]
      }
      if (patch.text !== undefined) invalidateToken(id)
      staleProfilesIn(s, String(m.about || ''), String(m.scope || ''))
      s.rev = (s.rev || 0) + 1
      return { ok: true, item: m }
    })
  }

  function revise(id, text, importance) {
    if (isClosed()) return false
    const t = String(text || '').trim().slice(0, 200)
    return mutate((s, abort) => {
      const m = s.items.find((x) => x.id === id)
      if (!m || !t) return abort(false)
      m.history = [...(m.history || []), { text: m.text, at: m.at }].slice(-3)
      m.text = t
      m.at = Date.now()
      m.importance = Math.max(Number(m.importance) || 0, Number(importance) || 0)
      invalidateToken(id)
      staleProfilesIn(s, String(m.about || ''), String(m.scope || ''))
      s.rev = (s.rev || 0) + 1
      return true
    })
  }

  function invalidate(id, byId = '', opts = {}) {
    if (isClosed()) return false
    const force = opts && typeof opts === 'object' ? opts.force === true : false
    return mutate((s, abort) => {
      const m = s.items.find((x) => x.id === id)
      if (!m) return abort(false)
      if (m.pinned && !force) return abort(false)
      m.invalidAt = Date.now()
      if (byId) m.supersededBy = byId
      staleProfilesIn(s, String(m.about || ''), String(m.scope || ''))
      s.rev = (s.rev || 0) + 1
      return true
    })
  }

  /**
   * 批量标成过时（一次 load + 一次 save）：用于梦境巩固等批量立墓碑路径，避免循环内逐条全库落盘。
   * 语义与 invalidate 一致：默认保护 pinned，仅 force=true 放行。
   * @param {Array<{oldId?:string, id?:string, newId?:string, byId?:string}>} pairs
   * @param {{force?: boolean}} [opts]
   * @returns {number} 实际立墓碑条数
   */
  function invalidateMany(pairs, opts = {}) {
    if (isClosed()) return 0
    const list = Array.isArray(pairs) ? pairs : []
    if (!list.length) return 0
    const force = opts && typeof opts === 'object' ? opts.force === true : false
    const applied = mutate((s, abort) => {
      const byIdMap = new Map(s.items.map((x) => [String(x.id), x]))
      const now = Date.now()
      let count = 0
      const stalePairs = new Set()
      for (const pair of list) {
        const id = String(pair?.oldId ?? pair?.id ?? '').trim()
        const byId = String(pair?.newId ?? pair?.byId ?? '').trim()
        if (!id) continue
        const m = byIdMap.get(id)
        if (!m || m.invalidAt) continue
        if (m.pinned && !force) continue
        m.invalidAt = now
        if (byId) m.supersededBy = byId
        count++
        if (m.about) {
          const pk = `${m.about}@${m.scope || ''}`
          if (!stalePairs.has(pk)) {
            stalePairs.add(pk)
            staleProfilesIn(s, String(m.about), String(m.scope || ''))
          }
        }
      }
      if (!count) return abort(0)
      s.rev = (s.rev || 0) + 1
      return count
    })
    return applied || 0
  }

  function restore(id) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    return mutate((s, abort) => {
      const m = s.items.find((x) => x.id === id)
      if (!m) return abort({ ok: false, message: '没有这条' })
      delete m.invalidAt
      delete m.supersededBy
      staleProfilesIn(s, String(m.about || ''), String(m.scope || ''))
      s.rev = (s.rev || 0) + 1
      return { ok: true }
    })
  }

  function remove(id) {
    if (isClosed()) return { ok: false, message: '记忆模块已关闭' }
    return mutate((s) => {
      const target = s.items.find((m) => m.id === id)
      s.items = s.items.filter((m) => m.id !== id)
      invalidateToken(id)
      if (target) staleProfilesIn(s, String(target.about || ''), String(target.scope || ''))
      s.rev = (s.rev || 0) + 1
      return { ok: true }
    })
  }

  /** 主人换号迁移：旧 QQ 号名下的私聊记忆（private:oldQQ 作用域 + 关于旧号的小档案）整体搬到新号。 */
  function reassignOwner(fromQQ, toQQ) {
    const from = String(fromQQ || '').replace(/\D/g, '')
    const to = String(toQQ || '').replace(/\D/g, '')
    if (from.length < 5 || to.length < 5) return { ok: false, message: 'QQ 号位数不对' }
    if (from === to) return { ok: false, message: '新旧号码一样' }
    const moved = mutate((s, abort) => {
      let count = 0
      for (const m of s.items) {
        let hit = false
        if (m.scope === `private:${from}`) { m.scope = `private:${to}`; m.chatId = `private:${to}`; hit = true }
        if (String(m.about || '') === from) { m.about = to; hit = true }
        if (String(m.aboutName || '') === from) { m.aboutName = to; hit = true }
        if (hit) count++
      }
      if (!count) return abort(0)
      staleProfilesIn(s, from)
      staleProfilesIn(s, to)
      s.rev = (s.rev || 0) + 1
      return count
    })
    log?.info?.(`主人迁移：${from} → ${to}，搬了 ${moved} 条记忆`)
    return { ok: true, moved, message: `搬了 ${moved} 条记忆到 ${to}` }
  }

  /** 召回负反馈（#5）：用户明显说「记错了」，最近注入过的记忆降权。 */
  function reportMiss(chatId, text) {
    const t = String(text || '')
    if (!t || !MISS_RE.test(t)) return 0
    const now = Date.now()
    const recallLog = getRecalls()
    for (const entry of recallLog) {
      if (now - Number(entry.at || 0) > 90_000) continue
      if (chatId && entry.where && entry.where !== chatId) continue
      const hits = entry.hits || []
      if (!hits.length) continue
      // 一次事务内降权本次召回的全部命中条目，再统一落盘一次
      const changed = mutate((s, abort) => {
        let count = 0
        const changes = []
        for (const h of hits) {
          const it = s.items.find((x) => x.id === h.id)
          if (!it) continue
          const before = Number(it.importance) || 0.5
          const after = Math.max(0.1, Math.round((before * 0.8) * 100) / 100)
          if (after === before) continue
          it.importance = after
          changes.push({ text: it.text, before, after })
          count++
        }
        if (!count) return abort(null)
        s.rev = (s.rev || 0) + 1
        return { touched: count, changes }
      })
      if (changed?.touched) {
        for (const c of changed.changes) {
          log?.info?.(`召回纠错：「${String(c.text).slice(0, 40)}」重要性 ${c.before} → ${c.after}（用户说记错了）`)
        }
        return changed.touched // 只纠最近一次召回
      }
    }
    return 0
  }

  function clearScope(chat) {
    if (isClosed()) return { scope: '', items: 0, profile: 0, insights: 0, style: 0 }
    // T3.8：内部（system）或身份不明的会话不许清分区 —— scopeOfChat 现在对它们返回
    // `private:unknown`，若放任继续执行就会把「unknown 分区」当真实分区清理，
    // 且面板/脚本传空 chat 时会误清一批记忆。
    if (!chat || chat.kind === 'system' || !['private', 'group'].includes(chat.kind)) {
      return { scope: '', items: 0, profile: 0, insights: 0, style: 0, refused: true }
    }
    const scope = scopeOfChat(chat)
    const key = personKey(chat)
    const res = mutate((s) => {
      const before = s.items.length
      s.items = s.items.filter((m) => String(m.scope || '') !== scope)
      const items = before - s.items.length
      const derivedCounts = clearDerivedForScope(s, { scope, key })
      s.rev = (s.rev || 0) + 1
      return { scope, items, ...derivedCounts }
    })
    clearRecalls?.()
    return res
  }

  function clearScopeEntries(scope) {
    if (isClosed()) return { ok: false, items: 0, message: '记忆模块已关闭' }
    const want = String(scope || '').trim()
    if (!want) return { ok: false, items: 0, message: '要先说清哪个分区' }
    return mutate((s) => {
      const before = s.items.length
      s.items = s.items.filter((m) => String(m.scope || '') !== want)
      const items = before - s.items.length
      const staleProfiles = items ? staleProfilesIn(s, '', want) : 0
      s.rev = (s.rev || 0) + 1
      return { ok: true, items, staleProfiles }
    })
  }

  function list(q) {
    const items = load().items
    const textOf = new Map(items.map((m) => [m.id, m.text]))
    const withBy = (m) => (m.supersededBy ? { ...m, supersededText: textOf.get(m.supersededBy) || '' } : m)
    if (!q) return items.slice().sort((a, b) => (Boolean(a.invalidAt) - Boolean(b.invalidAt)) || b.at - a.at).map(withBy)
    return search(indexAll(), q, { limit: 100, minScore: 0.01, includeInvalid: true }).map((h) => withBy({ ...h.it, score: Number(h.score.toFixed(2)) }))
  }

  function stats() {
    const items = load().items
    const live = items.filter((m) => !m.invalidAt)
    return {
      count: live.length,
      auto: live.filter((m) => m.source === 'auto').length,
      events: live.filter((m) => m.source === 'event').length,
      outdated: items.length - live.length,
      vector: vecStatusSafe(),
    }
  }

  return {
    add,
    addMany,
    addEvent,
    supersede: supersedeWithLog,
    invalidate,
    invalidateMany,
    recentEvents,
    recentEventsFor,
    update,
    revise,
    remove,
    restore,
    reassignOwner,
    reportMiss,
    importCommit,
    clearScope,
    clearScopeEntries,
    listFor,
    list,
    stats,
  }
}
