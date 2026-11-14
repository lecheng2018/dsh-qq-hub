import { randomUUID } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { readChatLogSource } from '../chat/chat-log.js'
import { consolidate as dreamConsolidateFacts } from './memory-dream.js'
import { createMemoryExtractor } from './memory-extractor.js'
import { similarity, whenText } from './memory-core.js'
import { createMemoryReflection } from './memory-reflection.js'
import { createMemoryStyle } from './memory-style.js'
import { characterName } from '../persona/identity-context.js'

export const CONSOLIDATION_MAX_ATTEMPTS = 3
export const CONSOLIDATION_RETRY_DELAYS_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000])

export function nextConsolidationRetry(previous, now, lastError) {
  const attempts = Math.max(0, Math.floor(Number(previous?.attempts) || 0)) + 1
  const capped = attempts >= CONSOLIDATION_MAX_ATTEMPTS
  const delay = CONSOLIDATION_RETRY_DELAYS_MS[Math.min(attempts - 1, CONSOLIDATION_RETRY_DELAYS_MS.length - 1)]
  return {
    attempts,
    nextRetryAt: capped ? 0 : now + delay,
    failedAt: now,
    lastError: String(lastError || '整理失败').slice(0, 300),
  }
}

export function consolidationRetryBlocked(retry, now = Date.now()) {
  const attempts = Math.max(0, Math.floor(Number(retry?.attempts) || 0))
  return attempts >= CONSOLIDATION_MAX_ATTEMPTS || Number(retry?.nextRetryAt || 0) > now
}

export function createMemoryLearning({
  dsh, getConfig, hub, chatLog = hub, log, personaText,
  isActive, createGenerationSignal, generationOf,
  load, save, health, relatedTo,
  add, revise, supersede, invalidate, scopeFromChatId, listFor,
  profileOf, setDerivedProfile, profileKeyOf,
  insightsOf, setDerivedInsights, styleOf, setDerivedStyle, personKey,
  reflectImpl, styleImpl,
}) {
  const sourceLog = chatLog?.listDays ? chatLog : { listDays: () => hub?.chatLogDays?.() || [], readDay: (day) => hub?.chatLogOf?.(day) || [] }
  const chatLogDays = () => sourceLog.listDays()
  const chatLogSnapshot = (day) => readChatLogSource(sourceLog, day)
  let batchRecoveryError = ''

  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const task = generationOf(null)
    const genSignal = task.signal
    try {
      const src = String(text || '').trim()
      if (!src) return []
      const chunks = []
      for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
      const out = []
      for (const part of chunks) {
        const r = await askModel(dsh, {
          cfg: getConfig(),
          system: `你帮一个叫「${characterName('', getConfig())}」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。`, 
          text: part,
          maxTokens: 2500,
          temperature: 0.2,
          signal: genSignal.signal,
        })
        const m = String(r).match(/\[[\s\S]*\]/)
        try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
      }
      const have = load().items
      const uniq = []
      for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
      return uniq.slice(0, 80)
    } catch (error) {
      if (!genSignal.isValid()) return []
      throw error
    } finally {
      task.cleanup()
    }
  }


  /** 按这个人的记忆重写小档案（记忆少于 3 条的不写）。scope 限定只用哪个作用域的记忆来写。 */
  async function buildProfile(qq, scope = '', genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      if (!isActive()) return false
      if (genSignal && !genSignal.isValid()) return false
    const cfg = getConfig()
    // 只用「这个作用域自己的」记忆写档案。
    // 以前还会把 global 记忆也喂进来（`|| scope === 'global'`），后果是：
    // 在陌生群里给主人写档案时，会把主人私聊里的私事混进去，提炼成一条 global 档案，
    // 于是「私事 → global → 哪里都能读」—— 等于绕过了所有隔离。
    // global 档案该由 global 自己那条线维护，不该由别的聊天代写。
    // scope 为空必须拒绝（fail-closed）：兜不住空 scope 就退化成全库，跨域污染重演。
    if (!String(scope || '').trim()) throw new Error('没说清用哪个作用域的记忆（private:/group:/global），拒绝重写')
    const sourceState = load()
    const sourceRev = sourceState.rev || 0
    const mine = sourceState.items
      .filter((m) => !m.invalidAt && String(m.about) === String(qq))
      .filter((m) => String(m.scope || '') === String(scope))
      .sort((a, b) => a.at - b.at)
    if (mine.length < 3) return false
    const name = mine.filter((m) => m.aboutName).at(-1)?.aboutName || ''
    const old = profileOf(qq, scope)?.text || ''
    let out = ''
    try {
      out = await askModel(dsh, {
        cfg,
        system: `你是「${characterName('', cfg)}」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。`, 
        text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
        maxTokens: 1500,
        temperature: 0.3,
        signal: genSignal?.signal,
      })
    } catch (err) {
      if (genSignal && !genSignal.isValid()) return false
      throw err
    }
    if (!isActive() || (genSignal && !genSignal.isValid())) return false
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
      return setDerivedProfile(qq, text, name, scope, mine, sourceRev)
    } finally {
      task.cleanup()
    }
  }



  const defaultStyle = createMemoryStyle({
    dsh, getConfig, personaText, log,
    styles: () => load().styles || {}, styleOf, setDerivedStyle,
    createGenerationSignal, generationOf, isActive,
  })
  const defaultReflection = createMemoryReflection({
    dsh, getConfig, personaText, log,
    insightsOf, setDerivedInsights, styleOf,
    setStyle: (key, list, { sourceFingerprint }) => defaultStyle.noteStyle(key, list, sourceFingerprint),
    createGenerationSignal, generationOf, isActive,
  })
  function reflect(chat, transcript, genSignal = null) {
    return reflectImpl ? reflectImpl(chat, transcript, genSignal) : defaultReflection.reflect(chat, transcript, genSignal)
  }

  function commitExtracted(x, { chatId, cfg, known, about }) {
    const op = String(x.op || 'add')
    const target = known.get(String(x.id || '').replace(/^#/, ''))
    if (op === 'update' && target && target.source !== 'panel') return revise(target.id, x.text, x.importance)
    if (op === 'outdated' && target) {
      return supersede({
        oldId: target.id,
        text: x.text,
        aboutName: x.about || target.aboutName || '',
        about: about || target.about || '',
        importance: x.importance ?? target.importance ?? 0.5,
        source: 'auto',
        chatId,
        scope: scopeFromChatId(chatId),
        evidence: x.evidence,
        entity: x.entity,
        topic: x.topic,
      }).ok
    }
    const tags = Array.isArray(x.tags) ? x.tags.map((tag) => String(tag).slice(0, 8)).slice(0, 2) : []
    const result = add({
      text: x.text,
      aboutName: x.about || '',
      about,
      tags,
      importance: x.importance ?? 0.5,
      source: 'auto',
      chatId,
      scope: scopeFromChatId(chatId),
      evidence: x.evidence,
      entity: x.entity,
      topic: x.topic,
    })
    return result.ok && (result.id || result.updated)
  }

  const batchState = {
    get: (id) => load().extractionBatches?.[id],
    start: (batch, scope) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = { fingerprint: batch.fingerprint, scope, status: 'running', added: 0, at: Date.now() }
      try { save(state) } catch (error) {
        batchRecoveryError = `提炼批次 ${batch.id} 无法记录运行状态，自动整理已暂停：${error.message}`
        throw error
      }
    },
    fail: (batch, scope, error) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = {
        fingerprint: batch.fingerprint,
        scope,
        status: error.factsCommitted ? 'pending' : 'failed',
        added: Number(error.factsCommitted) || 0,
        error: error.message,
        at: Date.now(),
      }
      try { save(state) } catch (saveError) {
        batchRecoveryError = `提炼批次 ${batch.id} 无法记录失败状态，自动整理已暂停：${saveError.message}`
        throw saveError
      }
    },
    done: (batch, scope, added) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = { fingerprint: batch.fingerprint, scope, status: 'done', added, at: Date.now() }
      try { save(state) } catch (error) {
        batchRecoveryError = `提炼批次 ${batch.id} 已提交事实但进度未确认，自动整理已暂停：${error.message}`
        throw error
      }
    },
  }
  const extractor = createMemoryExtractor({
    dsh, getConfig, relatedTo, commit: commitExtracted, isActive,
    reflect, batchState, scopeOf: scopeFromChatId, recoveryError: () => batchRecoveryError, log,
    consolidation: {
      health, load, save, chatLogDays, chatLogSnapshot,
      learnSelfStyle, buildProfile, profileKeyOf, createGenerationSignal,
    },
  })
  function extractFacts(chatId, transcript, genSignal = null) {
    return extractor.extractFacts(chatId, transcript, genSignal)
  }
  function extractLines(chatId, lines, genSignal = null) {
    return extractor.extractLines(chatId, lines, genSignal)
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  function consolidate(o = {}) {
    return extractor.consolidate(o)
  }

  function learnSelfStyle(genSignal = null) {
    return styleImpl ? styleImpl(genSignal) : defaultStyle.learnSelfStyle(genSignal)
  }

  /**
   * 闲时梦境巩固（US-016 / 计划书 §八.1）：把已存事实去重、证伪、归纳成经验条目。
   *
   * 红线：**物理 Markdown 事实源只增不改**。被合并/证伪的条目只产出 supersede 墓碑，
   * 由内存档案落盘为 invalidAt + supersededBy + supersededFrom，绝不删除行。
   * 归纳出的经验条目写进「派生洞察」，与事实源分离（可回滚、可重建）。
   *
   * 非致命：梦境出问题只记日志，不影响每日提炼本身的成功率。
   */
  async function dreamConsolidate({ scopes = [], options = {} } = {}) {
    try {
      if (!isActive()) return { ok: false, message: '记忆模块未启用' }
      // listFor 空 scopes 会 fail-closed 返回 []（直接空转）。调用方常常拿不到
      // "当前有哪些作用域"，所以这里从实际存储里推导：显式传了 scopes 就只处理那些，
      // 没传就覆盖全部非空作用域。
      let want = Array.isArray(scopes) ? scopes.map((x) => String(x ?? '').trim()).filter(Boolean) : []
      if (!want.length) {
        try {
          const all = load()?.items || []
          want = [...new Set(all.filter((m) => !m.invalidAt).map((m) => String(m.scope || '').trim()).filter(Boolean))]
        } catch { want = [] }
      }
      const rows = typeof listFor === 'function' && want.length ? listFor(want, { limit: 2000 }) : []
      const facts = (Array.isArray(rows) ? rows : [])
        .filter((f) => f && f.id && f.text && !f.invalidAt)
        .map((f) => ({
          id: String(f.id),
          text: String(f.text),
          scope: String(f.scope || ''),
          topic: String(f.topic || ''),
          entity: String(f.entity || ''),
          importance: Number(f.importance) || 0.5,
          tags: Array.isArray(f.tags) ? f.tags : [],
          pinned: f.pinned === true,
        }))
      if (!facts.length) return { ok: true, skipped: 'no-facts' }

      const out = dreamConsolidateFacts(facts, options)
      if (!out.ok) return out

      // 墓碑落盘：已在库中的条目被合并/证伪时只立墓碑（invalidate），绝不凭空插入第三条副本造成膨胀
      let applied = 0
      for (const tomb of (out.supersede || [])) {
        try {
          if (typeof invalidate === 'function') {
            if (invalidate(String(tomb.oldId), String(tomb.newId))) applied += 1
          } else if (typeof supersede === 'function') {
            const merged = (out.facts || []).find((f) => String(f.id) === String(tomb.newId))
            if (merged) {
              supersede({
                oldId: String(tomb.oldId),
                text: String(merged.text || ''),
                about: String(merged.entity || ''),
                tags: Array.isArray(merged.tags) ? merged.tags : [],
                importance: Number(merged.importance) || 0.5,
                entity: String(merged.entity || ''),
                topic: String(merged.topic || ''),
                source: 'dream',
              })
              applied += 1
            }
          }
        } catch (error) {
          log?.warn?.('梦境墓碑落盘失败（跳过该条，不删事实）：', error?.message || error)
        }
      }

      // 归纳出的经验条目写进派生洞察，使经验真正落地生效
      if (Array.isArray(out.experiences) && out.experiences.length && typeof setDerivedInsights === 'function') {
        const byPerson = new Map()
        for (const exp of out.experiences) {
          const sc = String(exp.scope || 'global')
          const key = sc.startsWith('private:') ? `qq:${sc.slice(8)}` : sc
          if (!byPerson.has(key)) byPerson.set(key, [])
          byPerson.get(key).push({
            id: `exp_${randomUUID().slice(0, 6)}`,
            text: String(exp.summary || exp.text || '').trim(),
            at: Date.now(),
          })
        }
        for (const [key, list] of byPerson) {
          try {
            setDerivedInsights(key, list, '梦境归纳', { sourceFingerprint: 'dream-consolidate' })
          } catch (err) {
            log?.warn?.('梦境经验保存失败（跳过）：', err?.message || err)
          }
        }
      }
      log?.info?.(`梦境巩固：输入 ${facts.length} 条，合并 ${out.merges?.length || 0}，证伪 ${out.conflicts?.length || 0}，经验 ${out.experiences?.length || 0}，墓碑落地 ${applied}`)
      return { ...out, applied }
    } catch (error) {
      log?.warn?.('梦境巩固失败（不影响每日提炼）：', error?.message || error)
      return { ok: false, message: String(error?.message || error) }
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    if (!isActive() || !health().ok) return
    const cfg = getConfig().memory
    if (!cfg.enabled || !cfg.dailyConsolidate) return
    const s = load()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = s.runs || {}
    const due = (cfg.consolidateTimes || []).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    if (!due.length) return
    if (consolidationRetryBlocked(s.lastConsolidate?.retry, now.getTime())) return
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (!isActive()) return
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
      // 提炼成功后接一次闲时梦境巩固（US-016）。失败不影响上面的成功记录：
      // 梦境只是把已存事实去重/证伪/归纳，是可重建的派生层。
      try {
        // scope 从最近的聊天流水里推导（listFor 空 scopes 会 fail-closed 返回空，
        // 传错数组等于空转）。r.scopes 由提炼器在提交时给出实际作用域。
        const scopes = Array.isArray(r.scopes) && r.scopes.length
          ? r.scopes
          : [...new Set((r.committed || []).map((x) => String(x.scope || '')).filter(Boolean))]
        if (scopes.length) await dreamConsolidate({ scopes })
      } catch (error) {
        log?.warn?.('梦境巩固异常（已忽略）：', error?.message || error)
      }
    } else if (r.message !== '正在整理中') {
      const s2 = load()
      const retry = nextConsolidationRetry(s2.lastConsolidate?.retry, Date.now(), r.message)
      s2.lastConsolidate = { ...(s2.lastConsolidate || {}), retry }
      save(s2)
      if (retry.attempts >= CONSOLIDATION_MAX_ATTEMPTS) {
        log?.warn?.(`每日整理连续失败 ${retry.attempts} 次，自动重试已暂停；请修复后手动整理一次以解除`)
      }
    }
  }


  function extractionBatches() {
    return structuredClone(load().extractionBatches || {})
  }

  function resolveExtractionBatch(id, action) {
    const state = load()
    const batch = state.extractionBatches?.[String(id || '')]
    if (!batch) return { ok: false, message: '找不到这个提炼批次' }
    if (!['running', 'pending'].includes(batch.status)) return { ok: false, message: `批次当前是 ${batch.status}，不需要恢复` }
    if (!['done', 'retry'].includes(action)) return { ok: false, message: '恢复动作只支持 done 或 retry' }
    if (action === 'done' && batch.status !== 'pending') return { ok: false, message: 'running 的事实提交情况未知，只能标记重试' }
    const recoveredAt = Date.now()
    const next = {
      ...batch,
      status: action === 'done' ? 'done' : 'failed',
      recoveredAt,
      recovery: action === 'done' ? 'manual-confirmed' : 'manual-retry',
    }
    if (action === 'retry') next.error = `人工标记重试：${batch.error || '事实提交状态未确认'}`
    state.extractionBatches = { ...(state.extractionBatches || {}), [String(id)]: next }
    save(state)
    return { ok: true, batch: structuredClone(next) }
  }

  return {
    api: {
      importCandidates,
      buildProfile, reflect, learnSelfStyle, consolidate, tick,
      extractionBatches, resolveExtractionBatch,
      dreamConsolidate,
    },
    reload: () => { batchRecoveryError = '' },
  }
}
