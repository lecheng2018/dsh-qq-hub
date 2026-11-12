// 索引记忆库：Markdown 档案 + 倒排索引（中文按二元字组切词，英文数字按词）+ BM25 打分，
// 再叠加「关于当前说话人」「重要程度」「新近程度」的加权。不依赖外部向量库，几千条也是毫秒级。
//
// 记忆来源：她自己调 remember 工具记的、后台从聊天里自动提炼的、主人在面板里手动加的。
// 召回时机：每一轮回复前，用「这一轮对方说的话」（太短就连上一句）检索最相关的几条，作为上下文悄悄告诉她。
//
// 借鉴的做法：
// - 遗忘曲线（MemoryBank）：记得多牢按「多久没想起 + 被想起过几天 + 重要程度」算，常聊到的忘得慢。
// - 整理时先比对旧记忆（Mem0）：新事实是新增、补充旧的，还是说明旧的过时了。
// - 过时不删（Graphiti）：旧记忆标成「已过时」，不再被想起，但留着历史、面板里能恢复。
// - 常驻的人物小档案（Letta 的 memory block）：每个人一小段印象，聊天时一直带着，不靠关键词碰运气。

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dataDir } from '../core/store.js'
import { askModel } from '../core/llm.js'
import { openMemoryFiles } from './memory-files.js'
import { conceptsOf } from './memory-concepts.js'
import { collectMemberLines, enoughEvidence, buildDistillPrompt, parseDistillProfile, mergeProfile, renderDistillHint, dedupConvo } from './distill.js'
import { sessionsDirFor, scanTranscripts, linesOf, speakerCounts } from './session-history.js'
import { workspaceDirOf } from '../chat/workspace.js'
import { readChatLogSource } from '../chat/chat-log.js'
import { createMemoryExtractor } from './memory-extractor.js'
import { CLARITY_STEPS, SCOPE_QUOTAS, TOTAL_CAP, agoText, buildIndex, clarityOf, contradicts, cutAtSentence, evictScopeItems, isOwnerMemory, memoryLine, parseReflection, quotaForScope, retention, search, shouldForget, similarity, whenText, tokenize } from './memory-core.js'
export { CLARITY_STEPS, SCOPE_QUOTAS, agoText, buildIndex, clarityOf, contradicts, cutAtSentence, evictScopeItems, isOwnerMemory, memoryLine, parseReflection, quotaForScope, retention, search, shouldForget, similarity, whenText, tokenize }


// ---------------- 纯函数层（1.3.48 拆到 memory-core.js，这里原样 re-export，对外入口不变） ----------------

export function createMemoryStore({ dsh, getConfig, hub, chatLog = hub, log, personaText, onDistillLearned }) {
  const sourceLog = chatLog?.listDays ? chatLog : { listDays: () => hub?.chatLogDays?.() || [], readDay: (day) => hub?.chatLogOf?.(day) || [] }
  const chatLogDays = () => sourceLog.listDays()
  const chatLogSnapshot = (day) => readChatLogSource(sourceLog, day)

  /** 从人设文本里抽「禁止」类硬规则行，给 style 学习当护栏（人设没写或没传 personaText 就返回空）。 */
  const personaGuard = () => {
    try {
      const t = String(personaText?.() || '')
      if (!t) return ''
      const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 80 && /禁止|不要|不许|不得|别成|别用|别刻意/.test(l))
      if (!lines.length) return ''
      return lines.slice(0, 12).join('\n')
    } catch { return '' }
  }

  /** 作用域配额淘汰：本作用域超了就裁（低重要度/auto 来源/最老先走），淘汰要留日志。 */
  function evictIfNeeded(s, scope) {
    // 作用域配额淘汰：超额则裁掉超额部分
    const quota = quotaForScope(scope)
    const inScope = s.items.reduce((n, m) => n + (String(m.scope || '') === String(scope) ? 1 : 0), 0)
    if (inScope > quota) {
      const removed = evictScopeItems(s.items, scope, quota)
      if (removed > 0) log?.info?.(`记忆库：${scope} 超出配额 ${quota} 条，淘汰了 ${removed} 条最不重要的`)
    }
    // 全库兜底上限：防极端情况（大量小作用域）无限涨
    if (s.items.length > TOTAL_CAP) {
      const victims = s.items.slice().sort((a, b) => (Number(a.importance || 0.5) - Number(b.importance || 0.5)) || (Number(a.at || 0) - Number(b.at || 0)))
        .slice(0, s.items.length - TOTAL_CAP).map((m) => m.id)
      const kill = new Set(victims)
      let n = 0
      for (let i = s.items.length - 1; i >= 0; i--) { if (kill.has(s.items[i].id)) { s.items.splice(i, 1); n++ } }
      if (n > 0) log?.info?.(`记忆库：全库超过兜底上限 ${TOTAL_CAP} 条，淘汰 ${n} 条`)
    }
  }
  // 作用域索引缓存（按 scope 分组）；任何写入都会 clear
  const cache = new Map() // scope -> { stamp, count, idx }
  // tokenize 结果缓存（id → Set）：add 的 dup 预筛每次扫几百上千条，重复切词是纯浪费。
  // 写入路径清（save 后条目可能变），读路径随便缓存。
  const tokCache = new Map()
  const tokOf = (m) => {
    let t = tokCache.get(m.id)
    if (!t) { t = new Set(tokenize(m.text)); tokCache.set(m.id, t) }
    return t
  }
  // 存储层与生命周期管理（B-01 规范）
  let status = 'active' // 'active' | 'closed'
  let batchRecoveryError = ''
  let activeGeneration = 1
  const abortControllers = new Set()

  function createGenerationSignal(timeoutMs = 60000) {
    const ac = new AbortController()
    const gen = activeGeneration
    abortControllers.add(ac)
    const timer = setTimeout(() => {
      try { ac.abort(new Error('模型请求超时')) } catch {}
    }, timeoutMs)
    timer.unref?.()
    return {
      signal: ac.signal,
      isValid: () => status === 'active' && activeGeneration === gen && !ac.signal.aborted,
      cleanup: () => {
        clearTimeout(timer)
        abortControllers.delete(ac)
      },
    }
  }

  if (['memories.db', 'memories.json', 'memories.meta.json'].some((name) => existsSync(dataDir(name)))) {
    let migrated = false
    try {
      migrated = JSON.parse(readFileSync(dataDir('memory/migration.json'), 'utf8')).status === 'success'
        && existsSync(dataDir('memory/state.json'))
    } catch {}
    if (!migrated) throw new Error(`旧记忆库尚未确认迁移，请停写并执行 node scripts/migrate-memory-markdown.js "${dataDir()}"；若 memory/ 已存在，须先人工核对冲突，禁止自动覆盖。`)
  }
  const store = openMemoryFiles(dataDir('memory'), { log })
  const load = () => {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    return store.load()
  }

  const pendingHitUpdates = new Map()
  let hitFlushTimer = null

  function scheduleFlushHits() {
    if (hitFlushTimer) return
    hitFlushTimer = setTimeout(() => {
      hitFlushTimer = null
      try { flushHits() } catch (error) { log?.warn?.('记忆命中统计保存失败：', error.message) }
    }, 5000)
    hitFlushTimer.unref?.()
  }

  function flushHits() {
    if (pendingHitUpdates.size) save(load())
  }

  const save = (s) => {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    for (const [id, delta] of pendingHitUpdates) {
      const m = s.items.find((x) => x.id === id)
      if (m) {
        if (delta.hitDays) m.hitDays = (m.hitDays || 0) + delta.hitDays
        m.hits = (m.hits || 0) + delta.hits
        m.lastHit = delta.lastHit
      }
    }
    store.save(s)
    pendingHitUpdates.clear()
    if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
    cache.clear()
    if (tokCache.size > 8000) tokCache.clear()
  }
  /**
   * 记忆索引。**必须带作用域**：索引只包含这个聊天看得见的条目。
   *
   * 这是整个隔离方案的地基。以前 index() 用全量 items 建索引，
   * 于是所有基于它的检索（recall、topicScore、relatedTo、面板搜索）天然跨域，
   * 谁忘了在调用点补过滤，谁就是一条泄漏通道 —— 实测陌生群提到「NAS」「Docker」
   * 就能通过 topicScore 命中主人的私聊记忆，把她的插话概率往上抬。
   *
   * 现在改成：索引按作用域分组构建并缓存，接口强制传 chat 或 scope。
   * 传 'global' 只拿 global；传 null/undefined 返回空索引（fail-closed，宁可不给）。
   */
  /**
   * 全量索引：**只在主人自己的管理路径用**（面板列表、导出、/new 之类）。
   * 任何面向聊天内容生成的检索都必须走 indexFor(chat)，否则就是跨域。
   */
  const indexAll = () => {
    const s = load()
    const stamp = (s.rev || 0) + ':' + s.items.length
    const hit = cache.get('__all__')
    if (hit && hit.stamp === stamp) return hit.idx
    const idx = buildIndex(s.items)
    cache.set('__all__', { stamp, idx })
    return idx
  }
  function scopeKeyOf(chatOrScope) {
    if (chatOrScope === 'global') return 'global'
    if (chatOrScope && typeof chatOrScope === 'object') return scopeOfChat(chatOrScope)
    // 字符串形式的作用域（'private:123' / 'group:456'）也认
    if (typeof chatOrScope === 'string' && chatOrScope.trim()) return chatOrScope.trim()
    return '' // 没给作用域：下面会被当成空索引
  }
  function indexFor(chatOrScope) {
    const scope = scopeKeyOf(chatOrScope)
    if (!scope) return buildIndex([]) // fail-closed：没说清楚给谁看，就什么都不给
    const chatLike = chatOrScope && typeof chatOrScope === 'object' ? chatOrScope : null
    // 缓存按存储版本失效，重载与正文写入都会递增 rev。
    const revNow = store ? store.load().rev : null
    if (revNow === null || revNow === undefined) {
      const s0 = load()
      const hit0 = cache.get(scope)
      if (hit0 && hit0.stamp === (s0.rev || 0) && hit0.count === s0.items.length) return hit0.idx
    } else {
      const hit0 = cache.get(scope)
      if (hit0 && hit0.stamp === revNow) return hit0.idx
    }
    const s = load()
    // 可看见的条目：本作用域的 + global（global 处处可见）
    const visible = s.items.filter((m) => {
      const sc = String(m.scope || '').trim()
      if (!sc) return false // 无作用域老数据：不再当 global 放行
      if (sc === 'global' || sc === scope) return true
      // 隔离 override（memory-privacy 的「不隔离」开关）：某聊天被开放时，
      // 放行的作用域条目也要并进索引 —— 只做 scopeVisible 不够，索引是按作用域物理建的。
      return chatLike && scopeOverrideFn && scopeOverrideFn(sc, chatLike)
    })
    const stamp = s.rev || 0
    const hit = cache.get(scope)
    if (hit && hit.stamp === stamp && hit.count === s.items.length) return hit.idx
    const idx = buildIndex(visible)
    cache.set(scope, { stamp, count: s.items.length, idx })
    return idx
  }

  /**
   * 记忆作用域：私聊里记的只在那个私聊可见，群里记的只在那群可见，global 到处可见。
   * 无作用域旧条目由离线迁移器隔离，不自动提升为 global。
   */
  function scopeOfChat(chat) {
    if (!chat || chat.kind === 'system') return 'global'
    if (chat.kind === 'private') return `private:${chat.userId}`
    if (chat.kind === 'group') return `group:${chat.groupId}`
    return 'global'
  }
  /** 从 chatId 字符串（'private:123' / 'group:456'）反推作用域；自动整理按聊天分批跑时用。 */
  function scopeFromChatId(chatId) {
    const id = String(chatId || '')
    if (id.startsWith('private:') || id.startsWith('group:')) return id
    // 推断不出来时返回空，由调用方决定兜底（不要在这里默默升成 global —— 那是泄漏的来源）
    return ''
  }
  /** 这条记忆在 chat 这个聊天里能不能被想起。
   *  没有 scope 的旧条目不可召回，等待人工确认归属。
   *  老数据若真是该公开的（她自己的设定等），迁移时显式标成 global 即可。
   *  scopeOverride（P0-4 后接 memory-privacy 的隔离开关）：某个聊天被面板设为「不隔离」时，
   *  由模块注册的判定函数决定放行哪些别的作用域（比如让这个群看到主人私聊的记忆）。
   *  主库不自己存开关，只提供挂点；没人注册时行为完全不变。 */
  let scopeOverrideFn = null
  function registerScopeOverride(fn) {
    scopeOverrideFn = typeof fn === 'function' ? fn : null
    cache.clear() // 放行规则变了，按作用域建的索引全部重建（否则旧索引里没有新放行的条目）
  }
  function scopeVisible(scope, chat) {
    const raw = String(scope || '').trim()
    if (!raw) return false // 老数据无作用域：一律不跨聊天可见（以前当 global 放行，是跨群泄漏的主因）
    if (raw === 'global') return true
    if (!chat || chat.kind === 'system') return false
    if (raw === scopeOfChat(chat)) return true
    if (scopeOverrideFn && scopeOverrideFn(raw, chat)) return true
    return false
  }

  function add({ text, about = '', aboutName = '', tags = [], importance = 0.5, source = 'tool', sourceId = '', chatId = '', scope = '', ephemeral = false, pinned = false, entity = '', topic = '', evidence = '', title = '' }) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const s = load()
    // 去重：很像的就更新旧的（时间、重要程度取新），不重复存。
    // 但否定词/反义状态不一致（养猫 vs 养狗、喜欢 vs 不喜欢）不算重复 —— 语义反转不能合并（P1-3）。
    const ownerQQ0 = String(getConfig()?.ownerQQ || '')
    const scopeGuess = String(scope || '').trim() || scopeFromChatId(chatId) || (ownerQQ0 ? `private:${ownerQQ0}` : 'global')
    // dup 只可能出现在同一作用域里（跨 scope 条目互相看不见，合并了也是泄漏）
    const scopeItems = s.items.filter((m) => String(m.scope || '') === scopeGuess)
    const tToks = new Set(tokenize(t))
    const maybe = (m) => {
      if (m.invalidAt) return false
      if (!about || !m.about || m.about === String(about)) {
        for (const w of tokOf(m)) if (tToks.has(w)) return true
      }
      return false
    }
    // B站「知识」条目同质化高（同一个视频反复被提炼）：相似度阈值收紧，二次提炼更容易合并而不是新增
    const biliLike = t.includes('B站') || tags.includes('B站') || scopeItems.some((m) => (m.tags || '').includes('B站'))
    const dupAt = biliLike ? 0.5 : 0.6
    const dup = scopeItems.find((m) => maybe(m) && similarity(m.text, t) >= dupAt
      && !contradicts(t, m.text, String(about || ''), String(m.about || ''), scopeGuess, String(m.scope || '')))
    if (dup) {
      dup.text = t.length >= dup.text.length ? t : dup.text
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      if (evidence) dup.evidence = String(evidence).slice(0, 200)
      if (entity) dup.entity = String(entity).slice(0, 30)
      if (topic) dup.topic = String(topic).slice(0, 20)
      if (pinned) dup.pinned = 1
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, message: '✓', updated: dup.id }
    }
    // 落库作用域：显式给了就用；否则按 chatId 推断（private:xxx / group:xxx）；
    // 都推断不出来时落到主人私聊（不落 global —— 无主的记忆一旦公开，就是跨群泄漏）
    const ownerQQ = String(getConfig()?.ownerQQ || '')
    const finalScope = String(scope || '').trim() || scopeFromChatId(chatId) || (ownerQQ ? `private:${ownerQQ}` : 'global')
    const item = {
      id: randomUUID().slice(0, 8),
      text: t,
      about: String(about || ''),
      aboutName: String(aboutName || ''),
      tags: (tags || []).slice(0, 5),
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
    }
    s.items.push(item)
    evictIfNeeded(s, finalScope)
    s.rev = (s.rev || 0) + 1 // 索引缓存按 rev 失效：新增条目必须 bump，否则下一轮检索还是旧索引
    save(s)
    return { ok: true, message: '✓', id: item.id }
  }

  /**
   * 显式替代操作（C-01 规范）：用新事实替代某条过时旧事实。
   * 新事实创建、旧事实失效（invalidAt 与 supersededBy）在单次事务中原子完成。
   */
  function supersede({ oldId, text, about = '', aboutName = '', tags = [], importance, source = 'auto', sourceId = '', chatId = '', scope = '', evidence = '', entity = '', topic = '', title = '' }) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    const s = load()
    const target = s.items.find((x) => x.id === oldId)
    if (!target) return { ok: false, message: '未找到被替代的旧事实' }
    if (target.pinned) return { ok: false, message: '手工固定的重要事实不能自动被替代' }

    const finalScope = String(scope || '').trim() || target.scope || scopeFromChatId(chatId)
    if (target.scope !== finalScope) {
      return { ok: false, message: '不同作用域的事实不能互相替代' }
    }

    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '新事实内容为空' }

    const newId = randomUUID().slice(0, 8)
    const newItem = {
      id: newId,
      text: t,
      about: String(about || target.about || ''),
      aboutName: String(aboutName || target.aboutName || ''),
      tags: (tags && tags.length ? tags : target.tags || []).slice(0, 5),
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
    }

    target.invalidAt = Date.now()
    target.supersededBy = newId
    s.items.push(newItem)
    evictIfNeeded(s, finalScope)
    s.rev = (s.rev || 0) + 1
    save(s)
    log.info?.(`记忆替代（Supersede）：「${target.text}」已失效 → 「${t}」[ID: ${newId}]`)
    return { ok: true, id: newId, oldId: target.id }
  }

  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const src = String(text || '').trim()
    if (!src) return []
    const chunks = []
    for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
    const out = []
    for (const part of chunks) {
      const r = await askModel(dsh, {
        cfg: getConfig(),
        system: '你帮一个叫「大肥鱼」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。',
        text: part,
        maxTokens: 2500,
        temperature: 0.2,
      })
      const m = String(r).match(/\[[\s\S]*\]/)
      try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
    }
    // 和已有记忆、彼此之间去重
    const have = load().items
    const uniq = []
    for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
    return uniq.slice(0, 80)
  }

  /** 导入旧档案第二步：把勾选的候选存进记忆库。 */
  /** 面板导入（M6）：scope 可选 'global'（所有聊天可见）或 private（默认，只主人私聊）。
   *  她自己的设定/公开常识应选 global，否则群里想起不来。 */
  function importCommit(items, { scope = 'private' } = {}) {
    const want = scope === 'global' ? 'global' : ''
    let n = 0
    for (const c of items || []) if (add({ text: c.text, aboutName: c.aboutName || '', importance: c.importance ?? 0.5, source: 'import', ...(want ? { scope: want } : {}) }).id) n++
    return n
  }

  /** 她自己做过的事（唱了歌、刷了 B 站……）：记成「经历」，最近一天的会常驻在上下文里。
   *
   *  作用域默认落在**主人私聊**，不是 global。原因：这类经历的源头几乎都是「算法按主人的兴趣
   *  推给她的内容」——「在B站看了《猫猫合集》」「刷到白米饭料理」表面是她的经历，
   *  实际暴露的是主人的兴趣画像。真实事故里陌生人正是靠这类条目套出
   *  「主人爱看猫狗搞笑合集」「对白米饭感兴趣」「对 NAS 自建感兴趣」。
   *
   *  所以：默认 private:<主人QQ>；要公开进所有聊天，必须显式传 scope: 'global'
   *  （只有「在别人空间公开评论」这种对方本来就看得见的事才配）。 */
  function addEvent({ text, about = '', aboutName = '', tags = [], importance = 0.45, scope = '', chat = null, chatId = '', ephemeral = false, sourceId = '', evidence = '' }) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    // 优先级：显式 scope > 当前 chat > chatId 推断 > 主人私聊（兜底不再是 global）
    const sc = String(scope || '').trim() || (chat ? scopeOfChat(chat) : scopeFromChatId(chatId))
    const ownerScope = String(getConfig()?.ownerQQ || '')
    const finalScope = sc === 'global' ? 'global' : sc || (ownerScope ? `private:${ownerScope}` : 'global')
    return add({ text, about, aboutName, tags: ['经历', ...tags], importance, source: 'event', sourceId, chatId: chatId || (chat && chat.chatId) || '', scope: finalScope, ephemeral, evidence })
  }

  /** 最近 hours 小时里她做过的事（经历 + 空间日记），新的在前。
   *  传了 chat 就只返回这个聊天可见的（和 recall 用同一套 scopeVisible），不传保持老行为。
   *  群聊一律返回空：她的「近况」在群里没有任何正当用途，只会变成谈资
   *  （「我最近在 B 站看猫猫」= 直接暴露主人的兴趣画像），所以连 global 也不注入。 */
  function recentEvents(hours = 24, limit = 4, chat = null) {
    if (chat && chat.kind === 'group') return []
    const since = Date.now() - hours * 3600_000
    // 无 chat 的调用（后台任务）一律空——fail-closed（M4）；后台要读就用 recentEventsFor 显式声明域。
    if (!chat) return []
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since)
      .filter((m) => scopeVisible(m.scope, chat))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  /** 后台任务专用读（M4）：和 recall 的 scopes 语义一致。不给 scopes 一律返回空（fail-closed），
   *  面板主人自用的 list() 不受影响。后台轮（B 站选关键词等）要读兴趣画像必须显式声明可见域。 */
  function listFor(scopes, { limit = 200 } = {}) {
    const want = [...(Array.isArray(scopes) ? scopes : scopes ? [scopes] : [])].map((x) => String(x ?? '').trim()).filter(Boolean)
    if (!want.length) return []
    const items = load().items.filter((m) => !m.invalidAt && want.includes(String(m.scope || '')))
    return items.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || b.at - a.at).slice(0, limit)
  }

  /** 后台任务专用：显式声明可见域的事件流水（与 listFor 同语义，不给域一律空）。 */
  function recentEventsFor(scopes, hours = 24, limit = 4) {
    const want = new Set([...(Array.isArray(scopes) ? scopes : scopes ? [scopes] : [])].map((x) => String(x ?? '').trim()).filter(Boolean))
    if (!want.size) return []
    const since = Date.now() - hours * 3600_000
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since && want.has(String(m.scope || '')))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  function update(id, patch) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    for (const k of ['text', 'about', 'aboutName', 'tags', 'importance']) if (patch[k] !== undefined) m[k] = patch[k]
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, item: m }
  }

  /** 补充或改正一条旧记忆：换成新说法，旧说法留进 history。 */
  function revise(id, text, importance) {
    if (status === 'closed') return false
    const s = load()
    const m = s.items.find((x) => x.id === id)
    const t = String(text || '').trim().slice(0, 200)
    if (!m || !t) return false
    m.history = [...(m.history || []), { text: m.text, at: m.at }].slice(-3)
    m.text = t
    m.at = Date.now()
    m.importance = Math.max(Number(m.importance) || 0, Number(importance) || 0)
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  /** 标成过时：不再被想起，但不删（面板里能看到被哪条取代、能恢复）。 */
  function invalidate(id, byId = '') {
    if (status === 'closed') return false
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return false
    m.invalidAt = Date.now()
    if (byId) m.supersededBy = byId
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  function restore(id) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    delete m.invalidAt
    delete m.supersededBy
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  function remove(id) {
    if (status === 'closed') return { ok: false, message: '记忆模块已关闭' }
    const s = load()
    s.items = s.items.filter((m) => m.id !== id)
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  /** 主人换号迁移：旧 QQ 号名下的私聊记忆（private:oldQQ 作用域 + 关于旧号的小档案）整体搬到新号。 */
  function reassignOwner(fromQQ, toQQ) {
    const from = String(fromQQ || '').replace(/\D/g, '')
    const to = String(toQQ || '').replace(/\D/g, '')
    if (from.length < 5 || to.length < 5) return { ok: false, message: 'QQ 号位数不对' }
    if (from === to) return { ok: false, message: '新旧号码一样' }
    const s = load()
    let moved = 0
    for (const m of s.items) {
      let hit = false
      if (m.scope === `private:${from}`) { m.scope = `private:${to}`; m.chatId = `private:${to}`; hit = true }
      if (String(m.about || '') === from) { m.about = to; hit = true }
      if (String(m.aboutName || '') === from) { m.aboutName = to; hit = true }
      if (hit) moved++
    }
    if (moved) { s.rev = (s.rev || 0) + 1; save(s) }
    log.info(`主人迁移：${from} → ${to}，搬了 ${moved} 条记忆`)
    return { ok: true, moved, message: `搬了 ${moved} 条记忆到 ${to}` }
  }

  // 召回负反馈（#5）：用户明显说「记错了」，最近注入过的记忆要降权——BM25 补不上的那半环。
  const MISS_RE = /(记错|不是这[个样]|谁跟你说的?|乱记|瞎记|胡说|没有?这回事|记岔|搞错|什么跟什么|不对吧|才不是)/
  function reportMiss(chatId, text) {
    const t = String(text || '')
    if (!t || !MISS_RE.test(t)) return 0
    const now = Date.now()
    let touched = 0
    for (const entry of recallLog) {
      if (now - Number(entry.at || 0) > 90_000) continue
      if (chatId && entry.where && entry.where !== chatId) continue
      for (const h of entry.hits || []) {
        const s = load()
        const it = s.items.find((x) => x.id === h.id)
        if (!it) continue
        const before = Number(it.importance) || 0.5
        const after = Math.max(0.1, Math.round((before * 0.8) * 100) / 100)
        if (after === before) continue
        it.importance = after
        s.rev = (s.rev || 0) + 1
        save(s)
        log.info(`召回纠错：「${String(it.text).slice(0, 40)}」重要性 ${before} → ${after}（用户说记错了）`)
        touched++
      }
      if (touched) break // 只纠最近一次召回
    }
    return touched
  }

  const recallLog = [] // 最近几次想起了什么（给面板看）
  function recall(query, { about, limit, where = '', context = '', chat = null, scopes = null } = {}) {
    const max = limit ?? getConfig().memory.recallCount
    // 传了 chat 就只留这个聊天可见的，后台调用必须显式声明 scopes。
    // 后台任务（没有 chat 概念）必须显式传 scopes 数组声明可见域（如 ['global','private:10000001']），
    // 否则一律拒绝（fail-closed）——防止后台路径拿到全库。
    const inScopes = (scope) => Array.isArray(scopes) && scopes.includes(String(scope))
    const scoped = (list) => (chat ? list.filter((h) => scopeVisible(h.it.scope, chat))
      : Array.isArray(scopes) ? list.filter((h) => inScopes(h.it.scope))
      : [])
    // 索引本身就按作用域建：传了 chat 只检索它看得见的条目（双保险，scoped 再滤一次）
    // scopes 数组模式：逐个作用域取索引合并检索（候选仍然只有声明过的域，不会碰到别的私聊）
    let idx
    if (chat) idx = indexFor(chat)
    else if (Array.isArray(scopes)) {
      idx = buildIndex(scopes.flatMap((sc) => {
        const i = indexFor(sc)
        return i ? i.docs.map((d) => d.it) : []
      }))
    } else idx = buildIndex([]) // 没声明可见域的后台调用：什么都不给
    const hits = scoped(search(idx, query, { about, limit: chat || Array.isArray(scopes) ? max * 3 : max })).slice(0, max)
    // 这一句没想起几条（「嗯嗯」「然后呢」）：用上一句再找找，分数打折
    if (context && hits.length < max) {
      const have = new Set(hits.map((h) => h.it.id))
      for (const h of scoped(search(idx, context, { about, limit: max * 3, minScore: 0.5 }))) {
        if (hits.length >= max) break
        if (!have.has(h.it.id)) hits.push({ ...h, score: h.score * 0.6, why: [...(h.why || []), '（上一句）'] })
      }
    }
    recallLog.unshift({ at: Date.now(), where, query: String(query).slice(0, 120), hits: hits.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(h.score.toFixed(2)), why: h.why || [] })) })
    recallLog.length = Math.min(recallLog.length, 20)
    if (hits.length) {
      const now = Date.now()
      const todayStr = new Date().toDateString()
      for (const h of hits) {
        const id = h.it.id
        const cur = pendingHitUpdates.get(id) || {
          hits: 0,
          lastHit: 0,
          hitDays: 0,
          lastDayStr: h.it.lastHit ? new Date(h.it.lastHit).toDateString() : ''
        }
        cur.hits += 1
        cur.lastHit = now
        if (cur.lastDayStr !== todayStr) {
          cur.hitDays += 1
          cur.lastDayStr = todayStr
        }
        pendingHitUpdates.set(id, cur)
      }
      scheduleFlushHits()
    }
    return hits
  }

  // ---------- 相处经验：按人（私聊按 QQ 号，群按群）归类的、概括性的「怎么和 TA 相处」，越聊越懂 ----------
  const personKey = (chat) => (chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : '')
  function insightsOf(key) {
    return (load().insights || {})[key] || []
  }
  // ---------------- 蒸馏群友（1.3.59）----------------
  // 指定某个群的某个人当数据源，学他的说话方式/性格/语气（不冒充他本人）。
  // 目标列表和学到的画像都存在记忆库里，跟着 memories.db 一起持久化。
  const distillKey = (gid, uid) => `group:${String(gid)}#${String(uid)}`
  /** 目标列表：[{ gid, uid, name }] */
  function distillTargets () {
    return (load().distillTargets || []).map((t) => ({ gid: String(t.gid), uid: String(t.uid), name: String(t.name || '') }))
  }
  function addDistillTarget ({ gid, uid, name }) {
    const g = String(gid || '').replace(/\D/g, '')
    const u = String(uid || '').replace(/\D/g, '')
    if (!g || !u) return { ok: false, message: '群号和 QQ 号都要填' }
    const s = load()
    s.distillTargets = s.distillTargets || []
    if (s.distillTargets.some((t) => String(t.gid) === g && String(t.uid) === u)) {
      return { ok: false, message: '这个群里的这个人已经在学了' }
    }
    s.distillTargets.push({ gid: g, uid: u, name: String(name || '').slice(0, 20) })
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, message: '加上了，下次整理记忆时开始学他的说话样子' }
  }
  function removeDistillTarget (gid, uid) {
    const g = String(gid || ''), u = String(uid || '')
    const s = load()
    const before = (s.distillTargets || []).length
    s.distillTargets = (s.distillTargets || []).filter((t) => !(String(t.gid) === g && String(t.uid) === u))
    if (s.distillTargets.length === before) return { ok: false, message: '没找到这个目标' }
    s.distill = s.distill || {}
    delete s.distill[distillKey(g, u)]
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, message: '不学了，学到的东西也一起清掉了' }
  }
  /** 某个目标的画像 { style, persona, tone, samples, updatedAt } */
  function distillOf (gid, uid) {
    return (load().distill || {})[distillKey(gid, uid)] || null
  }
  function putDistill (gid, uid, profile, evidenceCount) {
    const s = load()
    s.distill = s.distill || {}
    const key = distillKey(gid, uid)
    const old = s.distill[key] || null
    const merged = mergeProfile(old || {}, profile)
    // 兼容旧调用/旧存量把证据条数塞在 samples 里的形态（数字），认作条数而不是原话
    const incomingCount = Math.max(Number(evidenceCount) || 0, (profile && typeof profile.samples === 'number') ? profile.samples : 0)
    // 证据条数单独放 evidenceCount —— 以前叫 samples，把画像里的逐字原话数组（few-shot
    // 主信号）覆盖成了数字，注入时渲染出「- 「44」」这种鬼东西（1.3.64 修）
    s.distill[key] = { ...merged, evidenceCount: Math.max(Number(old && (old.evidenceCount != null ? old.evidenceCount : (typeof old.samples === 'number' ? old.samples : 0))) || 0, incomingCount), updatedAt: Date.now() }
    s.rev = (s.rev || 0) + 1
    save(s)
    return s.distill[key]
  }
  /** 面板用：显式目标与已学习画像的并集；历史学习即使没建目标也不能从面板消失。 */
  function distillList () {
    const rows = distillTargets().map((t) => ({ ...t, profile: distillOf(t.gid, t.uid) }))
    const seen = new Set(rows.map((t) => `${t.gid}#${t.uid}`))
    for (const [key, profile] of Object.entries(load().distill || {})) {
      const match = /^group:(\d+)#(\d+)$/.exec(key)
      if (!match || seen.has(`${match[1]}#${match[2]}`)) continue
      rows.push({ gid: match[1], uid: match[2], name: String(profile?.name || match[2]), profile })
    }
    return rows
  }

  // ---------------- 从会话历史蒸馏（1.3.63）----------------
  // chatlog 每天整理完就删，所以「新加的学习目标」只能干等。DSH 的会话记录留得久、
  // 而且存着群友原话「名字(QQ号)：内容」，翻它就能立刻学。

  /** 扫一遍会话历史，给出「谁说了多少句」和覆盖的时间范围（面板用）。 */
  function distillHistory ({ group = '' } = {}) {
    const cfg = getConfig()
    const dir = sessionsDirFor(workspaceDirOf(cfg), { dshHome: process.env.DSH_HOME || '' })
    const scan = scanTranscripts(dir, { group })
    return {
      dir,
      sessions: scan.sessions,
      total: scan.lines.length,
      from: scan.spans.from,
      to: scan.spans.to,
      speakers: speakerCounts(scan.lines, 20),
      lines: scan.lines,
    }
  }

  /**
   * 从历史里给某个目标学一次（立即出画像，不用等）。
   * @returns {{ok:boolean, message:string, learned?:object}}
   */
  async function learnDistillFromHistory ({ gid, uid, name = '', minMessages } = {}) {
    const cfg = getConfig()
    if (cfg.memory?.distill === false) return { ok: false, message: '蒸馏群友开关关着' }
    const g = String(gid || '').replace(/\D/g, '')
    const u = String(uid || '').replace(/\D/g, '')
    if (!g || !u) return { ok: false, message: '群号和 QQ 号都要填' }
    // 群名 → 只学这个群里的他；拿不到群名就按 QQ 号在全部群里找他
    let groupName = ''
    try { groupName = await hub.groupName(g) } catch {}
    if (groupName === g) groupName = ''
    const hist = distillHistory({ group: groupName })
    if (!hist.total) return { ok: false, message: '没找到会话历史' + (hist.dir ? '' : '（会话目录不存在）') }
    // 历史学习先清洗（去重 + 滤纯转发），清洗后质量高，门槛相应降到 15 句
    const mine = collectMemberLines(hist.lines.map((l) => ({ ...l, t: l.at })), u)
    const t0name = name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u
    const minMsg = Number(minMessages) || 15
    if (!enoughEvidence(mine, { minMessages: minMsg })) {
      return { ok: false, message: `历史里他的原话只有 ${mine.length} 句（去重滤转发后），不够 ${minMsg} 句，学出来也是瞎猜——等多聊几天再来` }
    }
    const others = hist.lines.filter((l) => String(l.uid) !== u && !/^\[分享卡片|^https?:/.test(String(l.text))).slice(-60).map((l) => `${l.name}：${String(l.text).slice(0, 100)}`)
    const old = distillOf(g, u)
    const { system, text } = buildDistillPrompt({
      name: name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u,
      uid: u,
      memberLines: mine,
      context: dedupConvo(hist.lines).slice(-80),
      others,
      old,
    })
    let out = ''
    try {
      // 8000：五段 JSON 会被截断（parse 就失败）；「自适应思考」模型的思考段也吃额度。
      // reasoningEffort 不钉死 'none'：MiniMax-M3.1-Flash 之类必须自适应思考，disabled 直接 400
      // → 蒸馏永远失败；交给 askModel 的 pickReasoningEffort 按模型能力挑。
      out = await askModel(dsh, { cfg, system, text, maxTokens: 8000, temperature: 0.3 })
    } catch (error) {
      return { ok: false, message: '提炼失败：' + error.message }
    }
    const profile = parseDistillProfile(out)
    if (!profile) {
      log.warn(`蒸馏群友（历史）：${t0name} 回包解析失败，原始前 200 字：`, String(out).slice(0, 200))
      return { ok: false, message: '模型回包没解析成 JSON（原因已记日志，可再点一次重试）' }
    }
    const hasProfile = Boolean(profile.exchanges?.length || profile.syntax?.length || profile.catchphrases?.length || profile.rhetoric?.length || profile.persona?.length || profile.samples?.length || profile.style?.length)
    if (!hasProfile) {
      log.info(`蒸馏群友（历史）：${t0name} 模型判空画像（可能重复转发太多），原始前 120 字：`, String(out).slice(0, 120))
      return { ok: false, message: '模型认为他的原话不够代表说话风格，暂时不学' }
    }
    const saved = putDistill(g, u, profile, mine.length)
    log.info(`蒸馏群友（历史）：学到 ${name || u} 的说话样子（${mine.length} 句原话）`)
    try { onDistillLearned && await onDistillLearned(g) } catch (error) { log.warn('刷新语感人设卡出错：', error.message) }
    return { ok: true, message: `从历史里学到了（${mine.length} 句）`, learned: saved }
  }

  function setInsights(key, list, name) {
    const s = load()
    s.insights = s.insights || {}
    s.insightNames = s.insightNames || {}
    s.insights[key] = list.slice(0, 8)
    if (name) s.insightNames[key] = name
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 说话方式：聊久了潜移默化学到的（对方的说话习惯 + 她自己慢慢养成的说法） ----------
  function styleOf(key) {
    return (load().styles || {})[key] || []
  }
  function setStyle(key, list) {
    const s = load()
    s.styles = s.styles || {}
    s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, key === 'self' ? 6 : 5)
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 人物小档案：每个人一小段印象（是谁、什么关系、喜好、近况），聊天时常驻 ----------
  // 档案按「QQ + 作用域」存：私聊里对她的印象不外流到群里，群里认识的也不带到私聊。
  // 键形如 "10000001@private:10000001" / "10000001@group:222333444" / "10000001@global"。
  // 老数据（只按 QQ 号存的）一律当 global，仍然哪里都能用，不会突然失忆。
  function profileKeyOf(qq, scope) {
    const q = String(qq || '')
    if (!q) return ''
    return `${q}@${scope || 'global'}`
  }
  /** 取这个 QQ 在某个作用域下的档案；scope 为空时返回 global 那份（面板/兼容用）。 */
  function profileOf(qq, scope) {
    const all = load().profiles || {}
    const key = profileKeyOf(qq, scope)
    if (key && all[key]) return all[key]
    if (scope) return null
    // 没给作用域：退回老的按 QQ 号存的那份（兼容旧调用与旧数据）
    return all[String(qq)] || null
  }
  function setProfile(qq, text, name = '', scope = '') {
    const s = load()
    s.profiles = s.profiles || {}
    const key = profileKeyOf(qq, scope)
    const t = String(text || '').trim().slice(0, 200)
    const prev = s.profiles[key]
    if (t) s.profiles[key] = { qq: String(qq), scope: scope || 'global', text: t, name: name || prev?.name || '', at: Date.now() }
    else delete s.profiles[key]
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  /** 按这个人的记忆重写小档案（记忆少于 3 条的不写）。scope 限定只用哪个作用域的记忆来写。 */
  async function buildProfile(qq, scope = '', genSignal = null) {
    if (status === 'closed') return false
    if (genSignal && !genSignal.isValid()) return false
    const cfg = getConfig()
    // 只用「这个作用域自己的」记忆写档案。
    // 以前还会把 global 记忆也喂进来（`|| scope === 'global'`），后果是：
    // 在陌生群里给主人写档案时，会把主人私聊里的私事混进去，提炼成一条 global 档案，
    // 于是「私事 → global → 哪里都能读」—— 等于绕过了所有隔离。
    // global 档案该由 global 自己那条线维护，不该由别的聊天代写。
    // scope 为空必须拒绝（fail-closed）：兜不住空 scope 就退化成全库，跨域污染重演。
    if (!String(scope || '').trim()) throw new Error('没说清用哪个作用域的记忆（private:/group:/global），拒绝重写')
    const mine = load().items
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
        system: '你是「大肥鱼」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。',
        text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
        maxTokens: 1500,
        temperature: 0.3,
        signal: genSignal?.signal,
      })
    } catch (err) {
      if (genSignal && !genSignal.isValid()) return false
      throw err
    }
    if (status === 'closed' || (genSignal && !genSignal.isValid())) return false
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
    setProfile(qq, text, name, scope)
    return true
  }

  /** 给系统提示词上下文用：人物小档案 + 相处经验（常驻）+ 按这一轮对方说的话检索到的记忆。 */
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    // 对这个人（群里是正在说话的几个人）的印象，不用等关键词碰上
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3) : chat.userId ? [chat.userId] : []
    // 档案按当前聊天作用域取：群聊只拿本群里认识的印象，私聊只拿这个私聊的，
    // 再加上 global（她自己设定、大家都该知道的）。私聊里的私事不会进群聊。
    const pScope = scopeOfChat(chat)
    // 当前聊天作用域的档案 + global 档案（不是二选一）：
    // global 档案是**显式标注为公开的那部分**（她自己是谁、大家都该知道的），哪里都能读。
    // 真正要防的是「私事被自动提炼成 global」——那在 buildProfile 里堵，
    // 而不是把 global 整个禁掉（禁掉会让所有正常的人设也读不到）。
    const profs = people
      .map((qq) => {
        const local = profileOf(qq, pScope)
        const glob = pScope === 'global' ? null : profileOf(qq, 'global')
        if (local && glob && local.text !== glob.text) return { ...local, text: `${local.text}；${glob.text}` }
        return local || glob
      })
      .filter(Boolean)
    if (profs.length) parts.push('（你对' + (chat.kind === 'group' ? '正在说话的人' : '对方') + '的印象：' + profs.map((p) => (chat.kind === 'group' && p.name ? p.name + '——' : '') + p.text).join('；') + '）')
    const ins = insightsOf(personKey(chat))
    if (ins.length) parts.push('（和' + (chat.kind === 'group' ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    if (chat.kind === 'group') {
      // 蒸馏群友（1.3.59）：这个群指定了要学的人，就带上他的说话样子（含「不冒充」边界）
      const gid = String(chat.groupId)
      for (const t of distillTargets()) {
        if (t.gid !== gid) continue
        const hint = renderDistillHint(t.name || t.uid, distillOf(t.gid, t.uid) || {})
        if (hint) parts.push(hint)
      }
      // 群黑话注入已移交独立模块 src/modules/slang/（自己的 context provider）
    }
    const sty = styleOf(personKey(chat))
    const self = styleOf('self')
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (chat.kind === 'group' ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人；若和人设里的硬性规则（尤其是「绝对禁止」）冲突，完全以人设为准，被禁的写法一条都不要用。）')
    }
    // 最近做过的事：不用等别人提，她自己记得（比如刚给你唱过歌）
    const recent = recentEvents(24, 4, chat)
    if (recent.length) parts.push('（你最近做过的事：' + recent.map((m) => `${agoText(m.at)}${m.text}`).join('；') + '。聊到了可以自然提起。）')
    // 注意：随每条消息变化的「相关记忆」不放在这里（#79）——运行时上下文快照每轮都会追加到历史，
    // 内容一变就多一份快照；放在用户消息里（recallHint）只占当轮，不会越滚越大。
    return parts.join('\n')
  }

  // 主人私聊里问起群里的事：才临时把最近 24 小时的群聊流水当成「她自己的见闻」补进这一轮
  // （不常驻、不写进记忆；默认关，面板「聊天 → 主人私聊」里可以调每个群几条、限定只取哪些群）
  const GROUP_TALK = /(群|群聊|群里|他们|大家|那些人在聊)/

  function groupBackdrop (chat, queryText) {
    if (!chat || chat.kind !== 'private') return ''
    const all = getConfig()
    const ob = all.group && all.group.ownerBrief
    if (!ob || ob.enabled !== true) return ''
    if (!all.ownerQQ || String(chat.userId) !== String(all.ownerQQ)) return ''
    if (!GROUP_TALK.test(String(queryText || ''))) return ''
    const now = Date.now()
    const cutoff = now - 86400_000
    let rows = []
    try {
      for (const dk of [dayKey(), dayKey(new Date(cutoff))]) {
        for (const l of chatLog?.readDay?.(dk) || hub?.chatLogOf?.(dk) || []) {
          if (!l || !String(l.chatId).startsWith('group:') || !String(l.text || '').trim()) continue
          const t = Number(l.t) || 0
          if (t && t < cutoff) continue
          rows.push(l)
        }
      }
      rows.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
    } catch (error) {
      return ''
    }
    // 群白名单：配了就只取这些群（不配 = 所有群）
    const allow = new Set((ob.groups || []).map(String))
    if (allow.size) rows = rows.filter((l) => allow.has(String(l.chatId).slice(6)))
    if (!rows.length) return ''
    // 按群分组，每个群各取最后 limit 条（最多 30），整体再兜一个上限
    const limit = Math.max(1, Math.min(30, Number(ob.lines) || 12))
    const byGroup = new Map()
    for (const l of rows) {
      const gid = String(l.chatId).slice(6)
      if (!byGroup.has(gid)) byGroup.set(gid, [])
      byGroup.get(gid).push(l)
    }
    const blocks = []
    let total = 0
    for (const [gid, list] of byGroup) {
      if (total >= 120) break
      const tail = list.slice(-limit)
      total += tail.length
      const name = hub?.groupNames?.get?.(gid) || ''
      const title = name && name !== gid ? `群「${name}」（${gid}）` : `群 ${gid}`
      const body = tail.map((l) => {
        const who = l.who === 'bot' ? '我' : (l.who || '有人')
        return `${who}：${String(l.text).replace(/\s+/g, ' ').trim().slice(0, 100)}`
      }).join('\n')
      blocks.push(`【${title} · 最近 ${tail.length} 条】\n${body}`)
    }
    log.info(`主人问起群里的事：补了 ${blocks.length} 个群、共 ${total} 条最近的群聊记录`)
    // 措辞当成「她自己的见闻」，而不是「给她看的材料」——
    // 否则她会回一句「我看到了」，而不是接着聊群里那件事本身。
    return '（下面是你最近在几个群里经历过的片段，属于你自己的见闻 —— **不是主人发给你的消息**，别当成主人在跟你说话。'
      + '主人提到群里的事时，就像回忆自己白天的经历一样接着说下去，不用特意说「我看到了」「我知道了」；'
      + '群里的私事也别主动往外讲。想知道某个具体群的情况，就看你记得的那个群。）\n'
      + blocks.join('\n\n') + '\n【以上是最近群里的情况】'
  }

  /**
   * 这一轮聊到的事相关的记忆（#79）：内容随每条消息变化，所以由模块在「交给她的内容」里附上，
   * 不放进每轮都会追加的运行时上下文快照。最多 4 条、总长 ≤ 300 字。
   */
  function recallHint(chat, queryText, prevText = '', { sessionId } = {}) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const q = String(queryText || '').trim()
    if (!q) return ''
    const backdrop = groupBackdrop(chat, q)
    const recent = recentEvents(24, 4, chat)
    const shown = new Set(recent.map((m) => m.id))
    // 说话人消解（P2-2）：群聊里「他养了什么」的「他」是这一轮在说话的人 ——
    // 把 speakersOf 当 about 数组传下去，检索时关于这些人的记忆加分。
    const about = chat && chat.kind === 'private' ? chat.userId
      : chat && chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3)
      : undefined
    // 「嗯嗯」「然后呢」这种短句单看检索不到东西，把上一句也带上
    const ctxText = q.length < 12 ? String(prevText || '').slice(-300) : ''
    const memCfg = (cfg.memory || {})
    const maxItems = Math.max(1, Math.min(20, Math.round(Number(memCfg.hintCount) || 8)))
    const maxChars = Math.max(120, Math.min(2000, Math.round(Number(memCfg.hintMaxChars) || 600)))
    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText, chat }).filter((h) => !shown.has(h.it.id)).slice(0, maxItems)
    // 泛问兜底（P2-1）：「他最近怎么样」和记忆没有任何字词/概念重叠，recall 严格按相关性返回空，
    // 模型会完全失忆。注入场景退而求其次给这个作用域最近的重要记忆（明确检索/清空契约不受影响）。
    if (!hits.length) {
      const now = Date.now()
      const fallback = (chat ? indexFor(chat).docs : [])
        .filter((d) => !d.it.invalidAt && !shown.has(d.it.id))
        .sort((a, b) => (Number(b.it.importance) || 0.5) - (Number(a.it.importance) || 0.5) || b.it.at - a.it.at)
        .slice(0, 2)
        .map((d) => ({ it: d.it, score: 0.3, why: ['（泛问兜底·最近重要）'] }))
      hits.push(...fallback)
    }
    if (!hits.length) return backdrop
    // 按条收，不按字腰斩：以前 4 条压 300 字再 slice，一条记到一半被切断，
    // 她读到的就是半句话（2026-11-05 实测记忆平均 165 字，等于只能看见不到两条）。
    const lines = []
    let used = 0
    for (const h of hits) {
      let line = memoryLine(h.it)
      if (line.length > 120) line = cutAtSentence(line, 120)
      if (lines.length && used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
    }
    const body = lines.join('\n')
    return ['（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：' + body + '）', backdrop].filter(Boolean).join('\n')
  }

  /** 回顾：结合最近聊天和已有经验，更新这个人的相处经验（合并、提炼、最多 8 条，概括不琐碎）。 */
  async function reflect(chat, transcript, genSignal = null) {
    const key = personKey(chat)
    if (!key) return 0
    const old = insightsOf(key)
    const oldStyle = styleOf(key)
    const who = chat.kind === 'group' ? '这个群' : '对方'
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你是「大肥鱼」，在回顾自己和' + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + (personaGuard() ? '人设硬性规则（style 不得与它冲突；被禁止的标点、格式、长度，对方用得再多也不许学）：\n' + personaGuard() + '\n' : '')
        + '只输出这个 JSON 对象。',
      text: `已有经验：\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n已记下的说话方式：\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n最近的聊天：\n${transcript}`,
      maxTokens: 1500,
      temperature: 0.3,
      signal: genSignal?.signal,
    })
    if (status === 'closed' || (genSignal && !genSignal.isValid())) throw new Error('回顾任务已取消')
    const { insights: rawIns, style: rawStyle } = parseReflection(out)
    if (rawStyle.length) setStyle(key, rawStyle)
    const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    if (!arr.length) return 0
    const now = Date.now()
    setInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '')
    log.info(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
    return arr.length
  }

  /** 这段聊天相关的旧记忆：关于在场的人的 + 和内容相关的，最多 15 条，给模型比对用。 */
  function relatedTo(chatId, transcript) {
    const ppl = new Set([...String(transcript).matchAll(/\((\d{5,})\)/g)].map((m) => m[1]))
    if (chatId.startsWith('private:')) ppl.add(chatId.slice(8))
    // 只在本聊天可见的记忆里挑：以前这里是全量 load().items，
    // 只要聊天记录里出现了某人的 QQ，就会把「关于这个人」的记忆全部捞进来 ——
    // 包括别的作用域的。实测陌生群提一句主人的 QQ，就能把主人私聊的「猫叫粥粥」
    // 当成已知事实喂给提炼模型，接着被写进这个群的新记忆。
    // 作用域：这个聊天自己的 + global。qzone / 推断不出作用的走私聊与 global 两路。
    const scope = scopeFromChatId(chatId)
    const items = load().items.filter((m) => {
      if (m.invalidAt || m.source === 'event' || m.source === 'diary') return false
      const sc = String(m.scope || '').trim()
      if (!sc) return false // 无 scope 老数据：不参与提炼（宁可不给）
      if (sc === 'global') return true
      return scope ? sc === scope : false
    })
    const out = items.filter((m) => m.about && ppl.has(String(m.about))).sort((a, b) => b.at - a.at).slice(0, 10)
    // 用当前聊天的索引：提炼 A 群聊天时，不该把主人私聊或 B 群的记忆当成「已知事实」喂给模型
    for (const h of search(indexFor(chatId), String(transcript).slice(-1500), { limit: 8, minScore: 0.5 })) {
      if (out.length >= 15) break
      if (!out.some((m) => m.id === h.it.id) && h.it.source !== 'event' && h.it.source !== 'diary') out.push(h.it)
    }
    return out
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
    dsh, getConfig, relatedTo, commit: commitExtracted, isActive: () => status === 'active',
    reflect, batchState, scopeOf: scopeFromChatId, recoveryError: () => batchRecoveryError, log,
    consolidation: {
      health: () => store.health(), load, save, chatLogDays, chatLogSnapshot,
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

  /** 从各人的说话方式里，沉淀出几条她自己不知不觉学会的说法（很少、很淡）。 */
  async function learnSelfStyle(genSignal = null) {
    if (status === 'closed') return
    if (genSignal && !genSignal.isValid()) return
    const s = load()
    const pool = Object.entries(s.styles || {}).filter(([k]) => k !== 'self').flatMap(([, v]) => v)
    if (pool.length < 3) return
    try {
      const out = await askModel(dsh, {
        cfg: getConfig(),
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。' + (personaGuard() ? ' 注意：下面这些人设硬性规则优先级最高，学到的说法不得与它冲突：' + personaGuard() : ''),
        text: `已经养成的：\n${styleOf('self').map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
        maxTokens: 800,
        temperature: 0.3,
        signal: genSignal?.signal,
      })
      if (status === 'closed' || (genSignal && !genSignal.isValid())) return
      const m = out.match(/\[[\s\S]*\]/)
      const arr = m ? JSON.parse(m[0]).map((t) => String(typeof t === 'string' ? t : t?.text || '')) : []
      if (arr.length) setStyle('self', arr)
    } catch (error) {
      if (genSignal && !genSignal.isValid()) return
      log.warn('沉淀说话方式失败：', error.message)
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    if (status === 'closed' || !store.health().ok) return
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
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
    }
  }

  /**
   * 群聊话题和这个聊天里的记忆有多相关（0~1），给插话判断用。
   *
   * **必须传 chat**。以前不传，查的是全量索引：陌生群只要提到主人私聊里出现过
   * 的词（实测「NAS」0.13、「Docker」0.25），插话相关度就被抬高 50% 权重下的对应值，
   * 她会因此主动开口，而开口的内容来自主人的私聊记忆 —— 事故的直接推力。
   * 现在按当前聊天的索引算，别处记的东西不会让她在陌生群里「感兴趣」。
   */
  function topicScore(text, chat = null) {
    if (!chat) return 0 // fail-closed：不知道在哪个聊天，就当不相关
    const hits = search(indexFor(chat), text, { limit: 1, minScore: 0.01 })
    return hits.length ? Math.min(1, hits[0].score / 3) : 0
  }

  /**
   * 清空某个聊天的记忆（/new 命令用）：只删这个作用域的东西，别的聊天不受影响。
   * 一起清掉三样，否则「清了记忆」她还会按旧档案和旧经验说话：
   *   1) 这个作用域下的记忆条目  2) 这个人的小档案  3) 相处经验 + 说话方式
   * 属于 global 的记忆不动（她自己的设定、公开发生的事）。注意 B 站/抖音这类浏览记录
   * 默认就落在主人私聊，所以执行 /new 会一并清掉 —— 这正是想要的效果。
   * @returns {{items:number, profile:number, insights:number, style:number}} 各清了多少
   */
  function clearScope(chat) {
    if (status === 'closed') return { scope: '', items: 0, profile: 0, insights: 0, style: 0 }
    const scope = scopeOfChat(chat)
    const key = personKey(chat)
    const s = load()
    const before = s.items.length
    // 只删 scope 完全等于当前聊天的；global 与别人的私聊一律保留
    s.items = s.items.filter((m) => String(m.scope || '') !== scope)
    const items = before - s.items.length
    let profile = 0
    if (key || scope) {
      s.profiles = s.profiles || {}
      for (const k of Object.keys(s.profiles)) {
        const p = s.profiles[k]
        const pScope = p?.scope || (k.includes('@') ? k.slice(k.lastIndexOf('@') + 1) : 'global')
        if (pScope === scope) { delete s.profiles[k]; profile++ }
      }
    }
    let insights = 0
    let style = 0
    if (key && s.insights && s.insights[key]) { insights = s.insights[key].length; delete s.insights[key] }
    if (key && s.styles && s.styles[key]) { style = (s.styles[key] || []).length; delete s.styles[key] }
    s.rev = (s.rev || 0) + 1
    save(s)
    recallLog.length = 0 // 面板上「最近想起了什么」也一起清掉，免得还显示着删掉的条目
    return { scope, items, profile, insights, style }
  }

  return {
    recallHint,
    scopeOfChat, scopeVisible, registerScopeOverride,
    add, addEvent, supersede, recentEvents, recentEventsFor, update, remove, restore, recall, contextFor, consolidate, tick, topicScore, importCandidates, importCommit, clearScope, relatedTo, indexFor, indexAll, reassignOwner, reportMiss, listFor,
    profiles: () => {
      const s = load()
      return Object.entries(s.profiles || {}).map(([key, p]) => {
        // key 形如 "qq@scope"；老数据是纯 qq（无 @），按 global 处理
        const at = key.lastIndexOf('@')
        const qq = p.qq || (at > 0 ? key.slice(0, at) : key)
        const scope = p.scope || (at > 0 ? key.slice(at + 1) : 'global')
        return { key, qq, scope, ...p, qq, scope }
      }).sort((a, b) => b.at - a.at)
    },
    profileOf, profileKeyOf, setProfile, buildProfile,
    recalls: () => recallLog.slice(),
    styles: () => load().styles || {},
    setStyle: (key, list) => setStyle(key, (list || []).map(String)),
    lastConsolidate: () => load().lastConsolidate || null,
    insights: () => {
      const s = load()
      return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
    },
    setInsights: (key, list) => setInsights(key, list.map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x))),
    /** 群黑话本（面板用）：[{ gid, list: [{id, word, meaning, at}] }] */
    slang: () => Object.entries(load().slang || {})
      .map(([gid, list]) => ({ gid, list: list || [] }))
      .filter((x) => x.list.length)
      .sort((a, b) => b.list.length - a.list.length),
    // 黑话本存储已移交独立模块 src/modules/slang/（memory.slang() 只读口保留供迁移）
    /** 蒸馏群友（1.3.59）：目标管理 + 画像读取（面板用） */
    distillList,
    distillTargets,
    distillOf,
    putDistill,
    distillHistory,
    learnDistillFromHistory,
    addDistillTarget,
    removeDistillTarget,
    /** 删一条相处经验：insights[key] 是 {id,text,at} 数组，按 id 摘掉一条。 */
    removeInsight: (key, id) => {
      const s = load()
      const list = (s.insights || {})[key] || []
      const next = list.filter((x) => String(x.id) !== String(id))
      if (next.length === list.length) return false
      setInsights(key, next, (s.insightNames || {})[key] || '')
      return true
    },
    /** 删一个人物小档案：profileKeyOf(qq, scope) 命中才删，text 传空字符串即删。 */
    removeProfile: (qq, scope) => { setProfile(qq, '', '', scope); return true },
    /** 后台任务专用读（M4）：和 recall 的 scopes 语义一致。不给 scopes 一律返回空（fail-closed），
     *  面板主人自用的 list() 不受影响。后台轮（B 站选关键词等）要读兴趣画像必须显式声明可见域。 */
    list: (q) => {
      const items = load().items
      // 面板里过时的也列出来（排在后面），能看到被哪条取代、能恢复
      const textOf = new Map(items.map((m) => [m.id, m.text]))
      const withBy = (m) => (m.supersededBy ? { ...m, supersededText: textOf.get(m.supersededBy) || '' } : m)
      if (!q) return items.slice().sort((a, b) => (Boolean(a.invalidAt) - Boolean(b.invalidAt)) || b.at - a.at).map(withBy)
      // 面板搜索：主人自己看全库，这里有意识地用全量索引
      return search(indexAll(), q, { limit: 100, minScore: 0.01, includeInvalid: true }).map((h) => withBy({ ...h.it, score: Number(h.score.toFixed(2)) }))
    },
    stats: () => {
      const items = load().items
      const live = items.filter((m) => !m.invalidAt)
      return { count: live.length, auto: live.filter((m) => m.source === 'auto').length, events: live.filter((m) => m.source === 'event').length, outdated: items.length - live.length }
    },
    /** 关闭存储层与生命周期管理（B-01 规范，同步且幂等）。 */
    dispose: () => {
      if (status === 'closed') return
      try { flushHits() } catch (error) {}
      if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
      status = 'closed'
      activeGeneration++
      for (const ac of abortControllers) {
        try { ac.abort(new Error('memory disposed')) } catch {}
      }
      abortControllers.clear()
      try { store.close() } catch (error) {}
    },
    health: () => store.health(),
    reload: () => {
      if (status === 'closed') throw new Error('记忆模块已关闭')
      activeGeneration++
      for (const ac of abortControllers) ac.abort(new Error('memory reloaded'))
      abortControllers.clear()
      if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
      store.reload()
      batchRecoveryError = ''
      cache.clear()
      tokCache.clear()
      const health = store.health()
      const message = health.ok ? '记忆档案已重新载入，索引已更新' : '部分档案或状态损坏，请修复后重新载入；自动整理已暂停'
      log?.info?.(message)
      return { ok: health.ok, health, message }
    },
  }
}
  // 群黑话本已重构为独立模块 src/modules/slang/（存储/学习/注入迁走；slang() 只读口保留供迁移）。
