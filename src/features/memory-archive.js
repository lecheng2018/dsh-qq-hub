// 索引记忆库：Markdown 档案 + 倒排索引 + BM25 + 向量 RRF + 可选精排。
//
// 薄门面：按职责拆为 5 个子模块（state-session / index-cache / crud / derived / recall），
// 本文件仅负责装配与 re-export，保持 `createMemoryArchive` 对外签名与返回对象 100% 兼容。

import { createMemoryStateSession } from './memory-state-session.js'
import { createMemoryIndexCache } from './memory-index-cache.js'
import { createMemoryDerived } from './memory-derived.js'
import { createMemoryCrud } from './memory-crud.js'
import { createMemoryRecall } from './memory-recall.js'
import { createVectorChannel } from './memory-vector.js'
import { createReranker } from './memory-rerank.js'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../core/store.js'

export function createMemoryArchive({ dsh, getConfig, hub, chatLog = hub, log, personaText, reflectionContext = true, styleContext = true, extend, vectorFlushDebounceMs, vectorFetchImpl }) {
  // 1) 向量通道（在 session 之前创建，session.save 依赖 vec）
  const vec = createVectorChannel({
    memoryDir: dataDir('memory'),
    getConfig: () => {
      const c = getConfig()
      const ext = (c.ext && c.ext.memory) || {}
      if (String(ext.vectorUrl || '').trim()) {
        return { ...c, memory: { ...(c.memory || {}), embeddings: { enabled: ext.vectorEnabled === true, url: ext.vectorUrl, apiKey: ext.vectorApiKey || '', model: ext.vectorModel || '', dim: ext.vectorDim } } }
      }
      return c
    },
    log,
    flushDebounceMs: vectorFlushDebounceMs,
    fetchImpl: vectorFetchImpl,
  })

  // 2) 状态会话（含迁移门禁、CAS 自愈、命中节流）
  const session = createMemoryStateSession({ log, vec })

  // 3) 派生数据层（profiles / insights / styles）— 先占位，等 indexCache 就绪后重建
  let derived = null

  // 4) 索引缓存（依赖 derived 的 activePersonaId 等，稍后回填）
  const indexCache = createMemoryIndexCache({ getConfig, load: session.load, getRev: () => session.rev(), derived: null })

  // 重新创建 derived 以注入 indexCache
  const derivedFinal = createMemoryDerived({ session, indexCache, getConfig })
  indexCache.derived = derivedFinal

  // 5) CRUD（依赖 indexCache + derivedFinal）
  const crud = createMemoryCrud({
    getConfig, log, session, indexCache, derived: derivedFinal,
    getRecalls: () => recall.recallLog,
    clearRecalls: () => recall.clearRecalls(),
    vecStatusSafe: () => { try { return vec.status() } catch { return { enabled: false } } },
  })

  // 6) 召回处理器（依赖 indexCache + crud + derivedFinal）
  const recall = createMemoryRecall({
    getConfig, hub, chatLog, log, session, indexCache, crud, vec, reranker: null,
    reflectionContext, styleContext,
  })

  // 7) Cross-encoder 精排（配置门控默认关）
  const reranker = createReranker({ getConfig, log })
  recall.reranker.current = reranker

  // 8) 绑定 session hooks：onSaved → 失效索引缓存
  session.bindHooks({
    onSaved: () => indexCache.invalidateAll(),
    onReload: () => indexCache.invalidateAll(),
  })

  // 9) extend（learning 扩展）
  const learning = extend?.({
    dsh, getConfig, hub, chatLog, log, personaText,
    isActive: () => session.isActive(), createGenerationSignal: session.createGenerationSignal, generationOf: session.generationOf,
    load: session.load, save: session.save, health: () => session.health(), relatedTo: recall.relatedTo,
    add: crud.add, addMany: crud.addMany, revise: crud.revise, supersede: crud.supersede, invalidate: crud.invalidate, listFor: crud.listFor, scopeFromChatId: indexCache.scopeFromChatId,
    profileOf: derivedFinal.profileOf, setProfile: derivedFinal.setProfile, setDerivedProfile: derivedFinal.setDerivedProfile, profileKeyOf: derivedFinal.profileKeyOf,
    insightsOf: derivedFinal.insightsOf, setInsights: derivedFinal.setInsights, setDerivedInsights: derivedFinal.setDerivedInsights, styleOf: derivedFinal.styleOf, setStyle: derivedFinal.setStyle, setDerivedStyle: derivedFinal.setDerivedStyle, personKey: derivedFinal.personKey,
  })

  // 10) 对外返回对象（与原 createMemoryArchive 完全一致的键集）
  return {
    recallHint: recall.recallHint,
    recallHintFused: recall.recallHintFused,
    vectorEnabled: () => vec.enabled(),
    vectorStatus: () => { try { return vec.status() } catch { return { enabled: false } } },
    vectorBackfill: (items) => vec.backfill(items),
    rerankStatus: () => { try { return reranker.status() } catch { return { enabled: false } } },
    scopeOfChat: indexCache.scopeOfChat, scopeVisible: indexCache.scopeVisible, registerScopeOverride: indexCache.registerScopeOverride,
    add: crud.add, addMany: crud.addMany, addEvent: crud.addEvent, supersede: crud.supersede, invalidate: crud.invalidate, recentEvents: crud.recentEvents, recentEventsFor: crud.recentEventsFor, update: crud.update, remove: crud.remove, restore: crud.restore, recall: recall.recall, recallFused: recall.recallFused, contextFor: recall.contextFor, topicScore: recall.topicScore, importCommit: crud.importCommit, clearScope: crud.clearScope, clearScopeEntries: crud.clearScopeEntries, clearProfilesInScope: derivedFinal.clearProfilesInScope, relatedTo: recall.relatedTo, indexFor: indexCache.indexFor, indexAll: indexCache.indexAll, reassignOwner: crud.reassignOwner, reportMiss: crud.reportMiss, listFor: crud.listFor,
    dreamConsolidate: (...args) => learning?.dreamConsolidate?.(...args),
    profiles: derivedFinal.profiles,
    profileOf: derivedFinal.profileOf, profileKeyOf: derivedFinal.profileKeyOf, setProfile: derivedFinal.setProfile,
    recalls: () => recall.recallLog.slice(),
    styles: derivedFinal.styles,
    setStyle: (key, list, opts) => derivedFinal.setStyle(key, (list || []).map(String), opts),
    lastConsolidate: derivedFinal.lastConsolidate,
    insights: derivedFinal.insights,
    insightsOf: derivedFinal.insightsOf, styleOf: derivedFinal.styleOf, styleSourceOf: derivedFinal.styleSourceOf, setDerivedInsights: derivedFinal.setDerivedInsights, setDerivedStyle: derivedFinal.setDerivedStyle,
    setInsights: (key, list, name, opts) => derivedFinal.setInsights(key, (list || []).map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x)), name, opts),
    removeInsight: derivedFinal.removeInsight,
    removeProfile: derivedFinal.removeProfile,
    list: crud.list,
    stats: crud.stats,
    dispose: session.dispose,
    health: () => session.health(),
    ...(learning?.api || {}),
    reload: () => {
      if (session.isClosed()) throw new Error('记忆模块已关闭')
      session.reload()
      indexCache.invalidateAll()
      const state = session.load()
      if (derivedFinal.staleAllIn(state)) { state.rev = (state.rev || 0) + 1; session.save(state) }
      const health = session.health()
      const message = health.ok ? '记忆档案已重新载入，索引已更新' : '部分档案或状态损坏，请修复后重新载入；自动整理已暂停'
      log?.info?.(message)
      return { ok: health.ok, health, message }
    },
  }
}
