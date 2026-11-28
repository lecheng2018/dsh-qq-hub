// 会话生命周期：清理、重置、人设变更重置、全量重置、孤儿巡检、聊天清单、会话反查，
// 以及「每一轮的唯一入口」会话取用 / 轮换 / 归档探测。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致）。
// 这些函数原来直接读写核心闭包里的会话状态表（mountedTools / ctxBoxes / personaBound /
// sessionPersonas / lastInboundText / sessionTurns / activeChatBySessionId / selectedModels /
// pendingResets …）。
// 拆出来时这些表**以活引用传入**（Map/Set 是引用类型，核心与本模块读写同一份，不会漂移）；
// registry / systemTurns / participants / groupNames 同理。判定用的 getConfig 是取数函数 →
// 每轮读最新配置，与拆分前一致。
//
// 为什么不把这些表搬进本模块：它们在 execute 主链（工具挂载、上下文注册、模型选择）里
// 被高频读写，搬走只会把闭包依赖倒过来，属于「硬拆闭包」，风险远大于收益。

import { personaIdFor, personaHash } from '../../persona/personas.js'
import { workspaceDirOf } from '../../chat/workspace.js'

export function createSessionLifecycle({
  dsh, getConfig, log, debug, onResetChat, ctxGet, chatViewFor,
  currentPersonaTarget,
  registry, systemTurns, participants, groupNames, resetImageBudget,
  sessionPersonas, lastInboundText, sessionTurns, activeChatBySessionId,
  ctxBoxes, ctxBound, ctxFallback, ctxFallbackDone, personaBound,
  mountedTools, slowNoticeSent, selectedModels, pendingResets,
  recentlyArchivedSessions, sessionAdapter,
}) {
  function cleanupSession(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return
    const mounted = mountedTools.get(sid)
    if (mounted) {
      for (const off of mounted.offs) { try { off?.() } catch {} }
      mountedTools.delete(sid)
    }
    ctxBoxes.delete(sid)
    ctxBound.delete(sid)
    ctxFallback.delete(sid)
    ctxFallbackDone.delete(sid)
    activeChatBySessionId.delete(sid)
    selectedModels.delete(sid)
    slowNoticeSent.delete(sid)
    sessionTurns.delete(sid)
    sessionAdapter?.forgetTitle?.(sid)
    resetImageBudget(sid) // 换会话 = 图片额度跟着归零（新会话历史里没有旧图）
    for (const key of personaBound) if (key === sid || key.startsWith(`${sid}::`)) personaBound.delete(key)
  }

  /** 重置当前 SessionRegistry 中的一个聊天；归档异步做，映射立即失效。 */
  function resetChat(chatKey) {
    const key = String(chatKey || '')
    // #263 的 `contextResetChats.delete(key)` 移植到这张统一标记表：重置即把这个聊天攒下的
    // 待重置理由清掉。会话都要换新了，旧理由再留着只会让下一条消息多归档一次（而且那些理由
    // 描述的是**这个旧会话**的失败）。放在 onResetChat 之前，与 #263 的时序一致。
    pendingResets.delete(key)
    try { onResetChat?.(key) } catch {}
    const entry = registry.peek?.(key)
    if (!entry?.sessionId) return false
    // 短时免误报：archiveSession 是异步的，归档落地前宿主若再次求值人设变量，
    // 不把即将归档的旧会话当「映射缺失」告警。
    if (recentlyArchivedSessions) {
      const now = Date.now()
      for (const [k, exp] of recentlyArchivedSessions) { if (exp <= now) recentlyArchivedSessions.delete(k) }
      recentlyArchivedSessions.set(String(entry.sessionId), now + 60_000)
    }
    try {
      const reg = ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry
      Promise.resolve(reg?.archiveSession?.(entry.sessionId, { stopActivity: true })).catch(() => {})
    } catch { /* 归档失败不影响重置 */ }
    cleanupSession(entry.sessionId)
    participants.clear(entry.sessionId)
    sessionPersonas.delete(key)
    lastInboundText.delete(key)
    try { registry.forget?.(key) } catch { /* ignore */ }
    debug(`会话已重置（新核心）：${key}`)
    return true
  }

  /**
   * 人设配置变更后，按「新旧预期人设」逐聊天比对，重置真正变了的那批会话。
   *
   * 为什么不让面板自己比：面板只有 `entry.personaId`（建会话时记下的），而
   *   - 各路由拿到的 sessions 视图经过不同包装，字段和时机都对不上；
   *   - 更关键的是 `personaId` 只记录「建会话那一刻」，之后 groupDefault /
   *     privateDefault 改了它不会动。用「旧记录 vs 新配置」去比，必然漏判
   *     （2026-11-15 真机：群聊默认锁在豆包卡，点「设为当前」切成小鲸鱼，
   *      群会话人设其实没变、也确实不该重置，但私聊被 privateDefault 同样锁住
   *      时用户看到的就是「切卡完全没反应」）。
   * 这里统一以**配置**为准算两边预期：oldConfig 的预期 vs 现状，换卡即有 diff。
   *
   * @param {object} oldConfig 变更前的配置（必须是人设变更前的快照）
   * @returns {{chatId:string, from:string, to:string}[]} 被重置的会话清单
   */
  function resetChatsForPersonaChange(oldConfig) {
    const nextCfg = getConfig()
    const changed = []
    let snap = {}
    try { snap = registry.snapshot() || {} } catch { return changed }
    for (const [chatKey, entry] of Object.entries(snap)) {
      if (!entry?.sessionId) continue
      let want = ''
      let had = ''
      try {
        want = personaIdFor(chatViewFor(chatKey), nextCfg)
        had = personaIdFor(chatViewFor(chatKey), oldConfig)
      } catch { continue }
      // 预期没变 = 这张卡对这条聊天没影响，历史里也没有别的卡，不用动它
      if (want === had) continue
      // 会话里固化的正是「id + 这一版正文」才跳过；只看 id 会漏掉「卡没换、正文改了」
      const recorded = sessionPersonas.get(chatKey) || {}
      const recordedId = String(recorded.personaId || '')
      const wantHash = personaHash(want)
      if (recordedId === want && String(recorded.personaHash || '') === wantHash) continue
      if (resetChat(chatKey)) changed.push({ chatId: chatKey, from: recordedId || had || '', to: want || '' })
    }
    return changed
  }

  /**
   * 重置所有系统会话并扫描 QQ 工作区中的历史孤儿会话，统一加入归档。
   */
  function resetAllSessions() {
    let archivedCount = 0
    try {
      const n = systemTurns.resetSessions?.() || 0
      archivedCount += n
    } catch {}

    try {
      const reg = ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry
      if (reg?.archiveSession) {
        const cfg = getConfig()
        const rootDir = workspaceDirOf(cfg)
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
        const normRoot = norm(rootDir)
        const workspaces = (reg.list?.() || []).filter((w) => {
          const p = norm(w.path)
          return p === normRoot || p.startsWith(normRoot + '/') || p.startsWith(normRoot + '\\')
        })
        const archived = new Set(reg.archivedSessionIds || [])
        for (const ws of workspaces) {
          for (const sid of (ws.sessionIds || [])) {
            if (!archived.has(sid)) {
              try {
                Promise.resolve(reg.archiveSession(sid, { stopActivity: true })).catch((err) => {
                  log?.debug?.(`归档工作区残留会话失败（${sid}）：${err?.message || err}`)
                })
                archived.add(sid)
                archivedCount++
              } catch (err) {
                log?.debug?.(`归档工作区残留会话失败（${sid}）：${err?.message || err}`)
              }
            }
          }
        }
      }
    } catch (err) {
      log?.debug?.(`扫描工作区孤儿会话失败：${err?.message || err}`)
    }
    return archivedCount
  }

  /**
   * 孤儿会话巡检：把 QQ 工作区里「既不在聊天映射、也不在后台系统会话池」的历史会话归档。
   *
   * 典型来源：服务重启后内存里的 `system:<key>` 映射丢了，昨天那批「刷 B 站 / 逛热榜」
   * 会话就再也没人认领；它们不是聊天，用户也不会去点，只会一直挂在侧栏。
   * 这里只做**分流**（归档 = 侧栏隐藏，文件与内容都还在，随时能找回）。
   *
   * 安全边界（宁可漏扫，绝不误伤正在用的会话）：
   *   · 只扫 QQ 专属工作区目录下的会话（按 cwd 判定），别的项目会话一概不碰；
   *   · 跳过活跃映射、系统会话池、当前回合反查表里的会话；
   *   · 跳过已归档、已置顶（归档会清置顶，视为用户显式保留）、空会话（草稿）；
   *   · 跳过仍在跑（running）的会话与子智能体会话；
   *   · 闲置不足 idleHours 的会话不动——刚建/刚用过的会话有足够安全垫。
   *
   * @param {{idleHours?:number, maxPerPass?:number, now?:number}} [options]
   * @returns {Promise<{scanned:number, archived:number, skipped:number}>}
   */
  async function sweepOrphanSessions(options = {}) {
    const result = { scanned: 0, archived: 0, skipped: 0 }
    try {
      const ctrl = ctxGet('sessionController')
      const reg = ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry
      if (typeof ctrl?.list !== 'function' || typeof reg?.archiveSession !== 'function') return result
      const cfg = getConfig()
      const idleHours = Math.max(1, Number(options.idleHours ?? cfg?.orphanSweep?.idleHours) || 6)
      const maxPerPass = Math.max(1, Math.floor(Number(options.maxPerPass ?? cfg?.orphanSweep?.maxPerPass) || 20))
      const now = Number(options.now) || Date.now()
      const cutoff = now - idleHours * 3600_000

      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
      const normRoot = norm(workspaceDirOf(cfg))
      const inScope = (p) => {
        const v = norm(p)
        return Boolean(v) && (v === normRoot || v.startsWith(`${normRoot}/`) || v.startsWith(`${normRoot}\\`))
      }

      const live = new Set()
      for (const entry of Object.values(registry.snapshot?.() || {})) {
        const sid = String(entry?.sessionId || '')
        if (sid) live.add(sid)
      }
      for (const sid of systemTurns.liveSessionIds?.() || []) live.add(String(sid))
      for (const sid of activeChatBySessionId.keys()) live.add(String(sid))

      const archived = new Set((reg.archivedSessionIds || []).map(String))
      const pinned = new Set((reg.pinnedSessionIds || []).map(String))

      const listed = await ctrl.list({})
      const items = Array.isArray(listed?.items) ? listed.items : []
      for (const row of items) {
        const sid = String(row?.sessionId || '')
        if (!sid) continue
        result.scanned++
        if (archived.has(sid) || live.has(sid) || pinned.has(sid)) { result.skipped++; continue }
        if (row.running === true) { result.skipped++; continue }
        if (row.blank === true) { result.skipped++; continue }
        if (row.origin === 'subagent' || row.parentSessionId) { result.skipped++; continue }
        // cwd 缺失时不猜：宁可漏扫，也不把别的工作区的会话当成 QQ 孤儿
        if (!inScope(row.cwd)) { result.skipped++; continue }
        // updatedAt 缺失/非法（NaN / <=0）同样跳过：绝不让 NaN > cutoff === false 绕过闲置保护误归档
        const updatedAt = Number(row.updatedAt)
        if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > cutoff) { result.skipped++; continue }
        if (result.archived >= maxPerPass) break
        try {
          await reg.archiveSession(sid, { stopActivity: true })
          archived.add(sid)
          result.archived++
          debug(`孤儿会话巡检：已归档 ${sid}`)
        } catch (error) {
          result.skipped++
          log?.debug?.(`孤儿会话巡检归档失败（${sid}）：${error?.message || error}`)
        }
      }
      if (result.archived) log.info(`孤儿会话巡检：本轮归档 ${result.archived} 个（闲置超过 ${idleHours} 小时，扫描 ${result.scanned}，跳过 ${result.skipped}）`)
    } catch (error) {
      log?.debug?.(`孤儿会话巡检失败：${error?.message || error}`)
    }
    return result
  }

  function knownChats() {
    return Object.entries(registry.snapshot()).map(([chatId, entry]) => {
      const kind = chatId.startsWith('group:') ? 'group' : 'private'
      const id = chatId.slice(kind.length + 1)
      // rawName：不带「QQ 群 · 」前缀的纯群名（查不到为空串）。审计 Q13：前端为了
      // 拿群名一直在请求一个已删除的 /groups/titles 路由（失败静默、永远退回群号）；
      // 现在统一走 /panel/chats，从这里取。
      const rawName = kind === 'group' ? String(groupNames.get(id) || '') : ''
      return { chatId, kind, id, name: kind === 'group' ? `QQ 群 · ${groupNames.get(id) || id}` : chatId, rawName, lastAt: Number(entry.lastTurnAt || entry.createdAt || 0) }
    }).sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 当前 SessionRegistry 的会话 id → chatKey 反查，供审批、提问和模块工具使用。 */
  function chatKeyOfSession(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return ''
    const hit = activeChatBySessionId.get(sid)
    if (hit) return hit
    const snap = registry.snapshot?.() || {}
    for (const [chatKey, entry] of Object.entries(snap)) {
      if (entry && String(entry.sessionId) === sid) return chatKey
    }
    // 兼容带/不带 session- 前缀两种写法：要求剥前缀后长度 >= 8 且严格全等（防 bare === '' 恒命中首条）
    const stripPrefix = (s) => (s.startsWith('session-') ? s.slice(8) : s)
    const bare = stripPrefix(sid)
    if (bare.length < 8) return ''
    for (const [chatKey, entry] of Object.entries(snap)) {
      const v = String(entry?.sessionId || '')
      if (v === sid || stripPrefix(v) === bare) return chatKey
    }
    for (const [k, chatKey] of activeChatBySessionId) {
      if (stripPrefix(k) === bare) return chatKey
    }
    return ''
  }

  // ---------- 会话取用 / 轮换 / 归档探测（第二轮从装配根搬入） ----------
  // 这三件事是「每一轮的唯一入口」（execute 与 runPromptTurn 都过 sessionForChat），
  // 读的人设指纹 / 回合计数都是本模块已有的活引用（sessionPersonas / sessionTurns），
  // currentPersonaTarget 以取数函数注入（它同时被装配根的会话映射读写，不复制）。
  // 实现按行原样搬出，未改任何判定顺序、错误文案或日志文本。

  /** 会话里固化的那份 vs 现在该用的那份：id 或正文指纹任一不同就算过期。 */
  const personaStale = (persona, sessionId, want) => !persona
    || String(persona.sessionId || '') !== String(sessionId || '')
    || String(persona.personaId || '') !== want.id
    || String(persona.personaHash || '') !== want.hash

  /** 这个会话该不该退休：回合数或年龄任一超过阈值就算该换（填 0 的那一项不参与判定）。 */
  function sessionRetired(entry, cfg) {
    const rot = cfg?.sessionRotation
    if (!rot || rot.enabled === false) return ''
    const turns = sessionTurns.get(String(entry.sessionId)) || 0
    const maxTurns = Number(rot.maxTurns) || 0
    if (maxTurns > 0 && turns >= maxTurns) return `${turns} 轮（上限 ${maxTurns}）`
    const maxAgeMs = (Number(rot.maxAgeHours) || 0) * 3600_000
    const createdAt = Number(entry.createdAt) || 0
    if (maxAgeMs > 0 && createdAt > 0 && Date.now() - createdAt >= maxAgeMs) {
      return `会话已 ${Math.round((Date.now() - createdAt) / 3600_000)} 小时（上限 ${Math.round(maxAgeMs / 3600_000)} 小时）`
    }
    return ''
  }

  /**
   * 这个会话是不是已经被 DSH 归档了。
   *
   * DSH 有一个常驻、关不掉的 `archived-session-gate`（dsh-api-session-controller）：
   * 对已归档会话的**每一步**返回 `{ kind: 'reject' }`，agent-loop 随即把回合落成
   * `turn/end reason.kind === 'blocked'` —— 一个模型调用都不会发生。
   *
   * 本插件此前从不问这件事：映射里存着的 sessionId 一旦在 DSH 侧被归档（用户手动归档/
   * 批量归档/第三方插件），之后每一轮都必然 blocked，而且 blocked 不命中超时自愈也不命中
   * 413 自愈，于是这个聊天**永久卡死**（真机 2026-11-21：群 900000003 连续 5 轮 blocked，pii-scan:ignore 示例群号，
   * 会话日志里 turn/start 与 turn/end 之间没有 step/start）。
   *
   * 归档是「侧栏里藏起来」而不是删除：会话文件还在，随时能找回。所以这里只做**分流**——
   * 已归档 → 映射作废、开新会话，旧会话原样留在归档里可检索。
   * @param {string} sessionId 待查会话。
   * @returns {boolean} 是否已归档。
   */
  function isSessionArchived(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return false
    try {
      const reg = ctxGet('workspaceRegistry')
      const ids = reg?.archivedSessionIds
      if (!ids) return false
      return typeof ids.includes === 'function' ? ids.includes(sid) : Array.from(ids).includes(sid)
    } catch { return false } // 查不到就当没归档，绝不因为探测失败而误换会话
  }

  async function sessionForChat(chatKey) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await registry.sessionFor(chatKey)
      if (registry.peek(chatKey)?.sessionId !== entry.sessionId) continue
      const want = currentPersonaTarget(chatKey)
      let persona = sessionPersonas.get(chatKey)
      if (!persona || persona.sessionId !== entry.sessionId) {
        persona = { sessionId: entry.sessionId, personaId: want.id, personaHash: want.hash }
        sessionPersonas.set(chatKey, persona)
      }
      // 归档判定放在人设/轮换之前：已归档的会话不管用得多新，**根本跑不了回合**，
      // 换不换人设都没有意义（而且不先救这一条，下面的人设分支也会一直 continue 到抛异常）。
      if (isSessionArchived(entry.sessionId)) {
        log.info(`会话已被 DSH 归档：${chatKey} 的会话 ${String(entry.sessionId).slice(-8)} 跑不了回合，重开新会话`)
        resetChat(chatKey)
        continue
      }
      if (!personaStale(persona, entry.sessionId, want)) {
        // 会话轮换：用太久/聊太多轮就归档重开。判在 sessionForChat 里是因为它是**每一轮的唯一入口**
        // （execute 与 runPromptTurn 都过这里），放别处会漏掉主动回合。
        // 放在人设判定之后：人设不对本来就该换，不必再谈退休。
        const retired = sessionRetired(entry, getConfig())
        if (retired) {
          log.info(`会话轮换：${chatKey} 的会话 ${String(entry.sessionId).slice(-8)} 已用 ${retired}，归档重开`)
          resetChat(chatKey)
          continue
        }
        sessionTurns.set(String(entry.sessionId), (sessionTurns.get(String(entry.sessionId)) || 0) + 1)
        return entry
      }
      resetChat(chatKey)
    }
    throw new Error(`人设变化过快，无法创建稳定会话：${chatKey}`)
  }

  /** 该会话是否处于「刚被 resetChat 归档、归档尚未落地」的短时窗口（人设变量求值时免误报）。 */
  function isArchivingSession(sessionId) {
    if (!recentlyArchivedSessions) return false
    const key = String(sessionId || '')
    const exp = recentlyArchivedSessions.get(key)
    if (!exp) return false
    if (exp <= Date.now()) { recentlyArchivedSessions.delete(key); return false }
    return true
  }

  return {
    cleanupSession,
    resetChat,
    resetChatsForPersonaChange,
    resetAllSessions,
    sweepOrphanSessions,
    knownChats,
    chatKeyOfSession,
    isArchivingSession,
    sessionForChat,
    isSessionArchived,
    sessionRetired,
  }
}
