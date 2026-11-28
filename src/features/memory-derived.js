// 记忆派生数据层：人物小档案（profiles）、相处经验（insights）、说话方式（styles）
// 的读写、人设双轨可见性隔离、事实变更/重载失效标记（stale*）及作用域清理。

import { DEFAULT_PERSONA_ID, normalizePersonaId } from './memory-persona-track.js'

const SELF_STYLE_KEY = 'self'
const isSelfStyleKey = (key) => key === SELF_STYLE_KEY

/**
 * 创建记忆派生数据管理器。
 */
export function createMemoryDerived({ session, indexCache = {}, getConfig }) {
  const { load, mutate, isClosed } = session
  const { activePersonaId } = indexCache

  /**
   * 派生桶（s.insights / s.styles）的人设可见性判定：
   *   1. 有 personaId：只对同一人设可见；
   *   2. 有 personaScope：同上；
   *   3. 都没有（历史存量）：默认归属默认人设，除非显式 shareUnlabeled（self 桶）。
   */
  function derivedVisibleTo(item, active, { shareUnlabeled = false } = {}) {
    if (!item || typeof item !== 'object') return true
    const pid = normalizePersonaId(item.personaId || item.persona)
    if (pid) return pid === active
    const scopePid = normalizePersonaId(item.personaScope)
    if (scopePid) return scopePid === active
    return shareUnlabeled || active === DEFAULT_PERSONA_ID
  }

  const personKey = (chat) => (chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : '')

  // ---------- 相处经验（insights） ----------

  function insightsOf(key, persona = activePersonaId(key)) {
    const active = normalizePersonaId(persona) || DEFAULT_PERSONA_ID
    return ((load().insights || {})[key] || [])
      .filter((item) => !item.stale)
      .filter((item) => derivedVisibleTo(item, active))
  }

  function staleInsightsIn(s, key = '') {
    let changed = 0
    for (const [person, list] of Object.entries(s.insights || {})) {
      if (key && person !== key) continue
      for (const item of list) {
        if (item.origin === 'manual' || item.stale) continue
        item.stale = true
        item.staleAt = Date.now()
        changed++
      }
    }
    return changed
  }

  function setInsights(key, list, name = '', opts = {}) {
    mutate((s) => {
      s.insights = s.insights || {}
      s.insightNames = s.insightNames || {}
      const defaultPid = normalizePersonaId((typeof opts === 'object' && opts?.personaId) || (typeof name === 'object' && name?.personaId) || '') || activePersonaId(key)
      s.insights[key] = list.slice(0, 8).map((item) => {
        const pid = normalizePersonaId(item.personaId || defaultPid)
        return { ...item, origin: 'manual', ...(pid ? { personaId: pid } : {}) }
      })
      const realName = typeof name === 'string' ? name : ''
      if (realName) s.insightNames[key] = realName
      s.rev = (s.rev || 0) + 1
    })
  }

  // 梦境共性归纳的固定 label：同一 label 视为同一条经验，覆盖更新而不是反复追加
  const DREAM_LABEL_RE = /^关于「([^」]+)」的共性归纳/
  const dreamLabelOf = (text) => {
    const m = String(text || '').trim().match(DREAM_LABEL_RE)
    return m ? m[1] : ''
  }

  function setDerivedInsights(key, list, name, { sourceFingerprint, personaId, merge = false } = {}) {
    mutate((s) => {
      s.insights = s.insights || {}
      s.insightNames = s.insightNames || {}
      const pid = normalizePersonaId(personaId) || activePersonaId(key)
      const mapped = list.slice(0, 8).map((item) => {
        const itemPid = normalizePersonaId(item.personaId || pid)
        return {
          ...item, origin: 'derived', sourceFingerprint, sourceRev: s.rev || 0,
          ...(itemPid ? { personaId: itemPid } : {}),
        }
      })
      if (merge) {
        // 追加合并（梦境归纳用）：保留既有反思经验、按正文或同 label（关于「...」的共性归纳）去重覆盖更新，
        // 避免条数变化（2条→3条）导致同类梦境经验反复追加。
        const merged = (Array.isArray(s.insights[key]) ? s.insights[key] : []).slice()
        const seen = new Set(merged.map((it) => String(it.text || '').trim()))
        for (const it of mapped) {
          const t = String(it.text || '').trim()
          if (!t) continue
          const label = dreamLabelOf(t)
          if (label) {
            const idx = merged.findIndex((cur) => dreamLabelOf(cur.text) === label)
            if (idx >= 0) {
              seen.delete(String(merged[idx].text || '').trim())
              merged[idx] = it
              seen.add(t)
              continue
            }
          }
          if (seen.has(t)) continue
          seen.add(t)
          merged.push(it)
        }
        s.insights[key] = merged.slice(0, 8)
      } else {
        s.insights[key] = mapped
      }
      if (name) s.insightNames[key] = name
      s.rev = (s.rev || 0) + 1
    })
  }

  function insights() {
    const s = load()
    return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
  }

  function removeInsight(key, id) {
    return mutate((s, abort) => {
      const list = (s.insights || {})[key] || []
      const next = list.filter((x) => String(x.id) !== String(id))
      if (next.length === list.length) return abort(false)
      s.insights = s.insights || {}
      s.insightNames = s.insightNames || {}
      const defaultPid = activePersonaId(key)
      s.insights[key] = next.slice(0, 8).map((item) => {
        const pid = normalizePersonaId(item.personaId || defaultPid)
        return { ...item, origin: 'manual', ...(pid ? { personaId: pid } : {}) }
      })
      s.rev = (s.rev || 0) + 1
      return true
    })
  }

  // ---------- 说话方式（styles） ----------

  /** 说话方式的落款：self 桶默认不落款（全局共享），其余按该聊天当前激活人设落款。 */
  function stylePidFor(key, personaId) {
    const explicit = normalizePersonaId(personaId)
    if (explicit) return explicit
    return isSelfStyleKey(key) ? '' : activePersonaId(key)
  }

  function styleSourceOf(key) {
    return (load().styleSources || {})[key] || null
  }

  function styleOf(key, persona = activePersonaId(key)) {
    const active = normalizePersonaId(persona) || DEFAULT_PERSONA_ID
    const src = styleSourceOf(key)
    if (src?.stale) return []
    const srcPid = normalizePersonaId(src?.personaId || src?.persona)
    if (srcPid && srcPid !== active) return []
    if (src?.personaScope && normalizePersonaId(src.personaScope) !== active) return []

    const list = (load().styles || {})[key] || []
    return list
      // T3.8：与 memory-persona-track 统一口径 —— 无 personaId 的历史风格条目归属默认人设，
      // 其他会话人设不得继承（shareUnlabeled 曾按 'self' 键无条件放行，等于人设隔离失效）。
      .filter((item) => derivedVisibleTo(item, active))
      .map((item) => (typeof item === 'object' && item !== null ? item.text || item.content || String(item) : String(item)))
  }

  function staleStylesIn(s, key = '') {
    let changed = 0
    for (const [name, meta] of Object.entries(s.styleSources || {})) {
      if ((key && name !== key) || meta.origin === 'manual' || meta.stale) continue
      meta.stale = true
      meta.staleAt = Date.now()
      changed++
    }
    return changed
  }

  function setStyle(key, list, { personaId } = {}) {
    mutate((s) => {
      s.styles = s.styles || {}
      s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, isSelfStyleKey(key) ? 6 : 5)
      const pid = stylePidFor(key, personaId)
      s.styleSources = { ...(s.styleSources || {}), [key]: { origin: 'manual', ...(pid ? { personaId: pid } : {}) } }
      s.rev = (s.rev || 0) + 1
    })
  }

  function setDerivedStyle(key, list, { sourceFingerprint, personaId } = {}) {
    mutate((s) => {
      s.styles = s.styles || {}
      s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, isSelfStyleKey(key) ? 6 : 5)
      const pid = stylePidFor(key, personaId)
      s.styleSources = { ...(s.styleSources || {}), [key]: { origin: 'derived', sourceFingerprint, sourceRev: s.rev || 0, ...(pid ? { personaId: pid } : {}) } }
      s.rev = (s.rev || 0) + 1
    })
  }

  function styles() {
    return load().styles || {}
  }

  // ---------- 人物小档案（profiles） ----------

  function profileKeyOf(qq, scope) {
    const q = String(qq || '')
    if (!q) return ''
    return `${q}@${scope || 'global'}`
  }

  function staleProfilesIn(s, qq = '', scope = '', { reason = 'mutate' } = {}) {
    let changed = 0
    for (const p of Object.values(s.profiles || {})) {
      if (p.origin === 'manual') continue
      if (qq && String(p.qq) !== String(qq)) continue
      if (scope && String(p.scope || 'global') !== String(scope)) continue
      if (p.stale) {
        if (reason !== 'append' && p.staleReason === 'append') {
          delete p.staleReason
          p.staleAt = Date.now()
          changed++
        }
        continue
      }
      p.stale = true
      p.staleAt = Date.now()
      if (reason === 'append') p.staleReason = 'append'
      else delete p.staleReason
      changed++
    }
    return changed
  }

  /** 取这个 QQ 在某个作用域下的档案；scope 为空时返回 global 那份（面板/兼容用）。 */
  function profileOf(qq, scope, persona = activePersonaId(scope)) {
    const active = normalizePersonaId(persona) || DEFAULT_PERSONA_ID
    const all = load().profiles || {}
    const key = profileKeyOf(qq, scope)
    const isReadable = (p) => Boolean(p && (!p.stale || p.staleReason === 'append'))
    const prof = key && isReadable(all[key]) ? all[key] : (!scope ? (isReadable(all[String(qq)]) ? all[String(qq)] : null) : null)
    if (!prof) return null
    const pid = normalizePersonaId(prof.personaId || prof.persona)
    if (pid && pid !== active) return null
    // T3.8：没有任何人设标签的历史档案归属默认人设 —— 非默认人设不许继承
    if (!pid && active !== DEFAULT_PERSONA_ID) return null
    if (prof.personaScope && normalizePersonaId(prof.personaScope) !== active) return null
    return prof
  }

  function setProfile(qq, text, name = '', scope = '', personaId = '') {
    mutate((s) => {
      s.profiles = s.profiles || {}
      const key = profileKeyOf(qq, scope)
      const t = String(text || '').trim().slice(0, 200)
      const prev = s.profiles[key]
      // T3.8：默认落「当前会话人设」，否则人设 B 的档案会以无标签条目写进去，
      // 非默认人设读不到（等于白写），默认人设又凭空多出一条别人的档案。
      const pid = normalizePersonaId(personaId || prev?.personaId) || activePersonaId(scope) || DEFAULT_PERSONA_ID
      if (t) s.profiles[key] = { qq: String(qq), scope: scope || 'global', text: t, name: name || prev?.name || '', at: Date.now(), origin: 'manual', ...(pid ? { personaId: pid } : {}) }
      else delete s.profiles[key]
      s.rev = (s.rev || 0) + 1
    })
  }

  function setDerivedProfile(qq, text, name, scope, facts, expectedRev, personaId = '') {
    return mutate((s, abort) => {
      if (expectedRev !== undefined && (s.rev || 0) !== expectedRev) {
        // 仅当同一作用域、同一人的有效非传闻来源事实实际变化时才放弃，避免后台无关 addEvent 误杀在途画像写入
        const liveFacts = (s.items || [])
          .filter((m) => !m.invalidAt && String(m.about) === String(qq) && String(m.scope || '') === String(scope || 'global') && m.status !== 'hearsay')
          .sort((a, b) => a.at - b.at)
        const same = Array.isArray(facts)
          && liveFacts.length === facts.length
          && liveFacts.every((m, idx) => String(m.id) === String(facts[idx]?.id) && String(m.text) === String(facts[idx]?.text))
        if (!same) return abort(false)
      }
      s.profiles = s.profiles || {}
      const key = profileKeyOf(qq, scope)
      const pid = normalizePersonaId(personaId || s.profiles[key]?.personaId)
      s.profiles[key] = {
        qq: String(qq), scope: scope || 'global', text: String(text || '').trim().slice(0, 200),
        name: name || s.profiles[key]?.name || '', at: Date.now(), origin: 'derived',
        sourceFactIds: facts.map((item) => String(item.id)), sourceRev: s.rev || 0,
        ...(pid ? { personaId: pid } : {}),
      }
      s.rev = (s.rev || 0) + 1
      return true
    })
  }

  function profiles() {
    const s = load()
    return Object.entries(s.profiles || {}).map(([key, p]) => {
      // key 形如 "qq@scope"；老数据是纯 qq（无 @），按 global 处理
      const at = key.lastIndexOf('@')
      const qq = p.qq || (at > 0 ? key.slice(0, at) : key)
      const scope = p.scope || (at > 0 ? key.slice(at + 1) : 'global')
      return { key, ...p, qq, scope }
    }).sort((a, b) => b.at - a.at)
  }

  function removeProfile(qq, scope) {
    setProfile(qq, '', '', scope)
    return true
  }

  function clearProfilesInScope(scope) {
    if (isClosed()) return { ok: false, profiles: 0, message: '记忆模块已关闭' }
    const want = String(scope || '').trim()
    if (!want) return { ok: false, profiles: 0, message: '要先说清哪个分区' }
    return mutate((s) => {
      const before = Object.keys(s.profiles || {}).length
      for (const k of Object.keys(s.profiles || {})) {
        const p = s.profiles[k]
        const pScope = p?.scope || (k.includes('@') ? k.slice(k.lastIndexOf('@') + 1) : 'global')
        if (pScope === want) delete s.profiles[k]
      }
      const removed = before - Object.keys(s.profiles || {}).length
      s.rev = (s.rev || 0) + 1
      return { ok: true, profiles: removed }
    })
  }

  function clearDerivedForScope(s, { scope, key }) {
    let profile = 0
    if (key || scope) {
      s.profiles = s.profiles || {}
      for (const k of Object.keys(s.profiles)) {
        const p = s.profiles[k]
        const pScope = p?.scope || (k.includes('@') ? k.slice(k.lastIndexOf('@') + 1) : 'global')
        if (pScope === scope) { delete s.profiles[k]; profile++ }
      }
    }
    let insightsCount = 0
    let styleCount = 0
    if (key && s.insights && s.insights[key]) { insightsCount = s.insights[key].length; delete s.insights[key] }
    if (key && s.styles && s.styles[key]) { styleCount = (s.styles[key] || []).length; delete s.styles[key]; if (s.styleSources) delete s.styleSources[key] }
    return { profile, insights: insightsCount, style: styleCount }
  }

  function staleAllIn(s) {
    return staleProfilesIn(s) + staleInsightsIn(s) + staleStylesIn(s)
  }

  function lastConsolidate() {
    return load().lastConsolidate || null
  }

  return {
    derivedVisibleTo,
    personKey,
    insightsOf,
    staleInsightsIn,
    setInsights,
    setDerivedInsights,
    insights,
    removeInsight,
    styleSourceOf,
    styleOf,
    staleStylesIn,
    setStyle,
    setDerivedStyle,
    styles,
    profileKeyOf,
    staleProfilesIn,
    profileOf,
    setProfile,
    setDerivedProfile,
    profiles,
    removeProfile,
    clearProfilesInScope,
    clearDerivedForScope,
    staleAllIn,
    lastConsolidate,
  }
}
