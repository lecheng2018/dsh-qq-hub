/** @type {import('../qq-hub').QQHubModule} */
import { resolve } from 'node:path'
import { buildDistillPrompt } from './prompt.mjs'
import { verifyAndCleanRules, safeParseJsonArray } from './verifier.mjs'
import { createDistillStore } from './store.mjs'
import { scanHistoryGroups, sampleGroupHistory } from './history-miner.mjs'

export default {
  id: 'distill',
  name: '群友蒸馏（测试版）',
  version: '1.0.0-beta.4',
  api: 1,
  description: '【测试版】移植 MaiBot 语感提炼机制，高信噪比提取群友接话习惯与口癖，设置频次门槛，绝不强行加戏。',
  panel: 'panel.js',
  tab: 'distill',
  defaults: {
    enabled: true,
    globalSharing: true,    // 全局共享语感底座（各群提炼互通汇聚，新群免冷启动）
    batchSize: 15,
    maxCapacity: 100,
    minPromotionCount: 3,   // 准入门槛：至少出现3次或锁定的规则才允许实际生效
    maxInjectedRules: 1,    // 命中时最多参考1条，杜绝注意力过载与刻意造句
    activeGroups: '',
  },
  settings: [
    { key: 'enabled', label: '启用群友蒸馏', type: 'switch' },
    { key: 'globalSharing', label: '全局共享语感底座（各群提炼互通汇聚，新群免冷启动）', type: 'switch' },
    { key: 'minPromotionCount', label: '正式生效门槛（群友使用频次 ≥）', type: 'number', min: 2, max: 10 },
    { key: 'batchSize', label: '实时分析触发阈值（条）', type: 'number', min: 10, max: 50 },
    { key: 'maxCapacity', label: '每群规则库上限', type: 'number', min: 30, max: 500 },
    { key: 'maxInjectedRules', label: '单次回复最多参考规则数', type: 'number', min: 1, max: 3 },
    { key: 'activeGroups', label: '指定生效群号（逗号分隔，留空全生效）', type: 'text' },
  ],

  setup(api) {
    const store = createDistillStore(api.dataDir())
    const buffers = new Map() // groupId -> [] 待提炼消息缓存
    const recentChatCache = new Map() // groupId -> [] 最近5条发言（用于实时上下文情境匹配）

    const storeLib = api.lib?.('core/store.js')
    const chatLogDir = storeLib?.dataDir ? storeLib.dataDir('chatlog') : resolve(api.dataDir(), '../../chatlog')

    function isGroupActive(groupId) {
      const cfg = api.settings()
      if (cfg.enabled === false) return false
      const activeStr = String(cfg.activeGroups || '').trim()
      if (!activeStr) return true
      const allowed = activeStr.split(/[,，\s\n]+/).map(s => s.trim()).filter(Boolean)
      return allowed.includes(String(groupId))
    }

    function recordRecentChat(groupId, who, text) {
      let list = recentChatCache.get(groupId)
      if (!list) {
        list = []
        recentChatCache.set(groupId, list)
      }
      list.push({ who, text, t: Date.now() })
      if (list.length > 8) list.shift()
    }

    // 监听实时群消息
    api.on('message', async (msg) => {
      const isGroup = msg?.kind === 'group' || Boolean(msg?.groupId) || (msg?.chatId && String(msg.chatId).startsWith('group:'))
      if (!isGroup) return false

      const gid = String(msg.groupId || (msg.chatId ? String(msg.chatId).replace(/^group:/, '') : ''))
      if (!gid || !isGroupActive(gid)) return false

      const text = String(msg.text || '').trim()
      if (!text || text.startsWith('/')) return false

      const who = String(msg.nickname || msg.sender?.card || msg.sender?.nickname || '群友')
      const botQQ = String(api.config?.()?.botQQ || '')
      const isBot = Boolean(botQQ && String(msg.userId) === botQQ)

      // 记录到近期滑动窗口，供精确情境匹配
      recordRecentChat(gid, who, text)

      // 铁律：Bot 发言绝不入蒸馏池
      if (isBot) return false

      let buf = buffers.get(gid)
      if (!buf) {
        buf = []
        buffers.set(gid, buf)
      }

      buf.push({
        name: who,
        userId: String(msg.userId || ''),
        isBot: false,
        text,
        t: Date.now(),
      })

      api.log.debug(`[群友蒸馏] 群 ${gid} 实时收到一条候选消息，当前缓存: ${buf.length}`)

      const threshold = Number(api.settings().batchSize) || 15
      if (buf.length >= threshold) {
        const lines = buf.splice(0, buf.length)
        api.later(200, () => runDistillLines(gid, lines))
      }

      return false
    })

    async function runDistillLines(groupId, lines) {
      try {
        const { system, text } = buildDistillPrompt(lines)
        const out = await api.ask({ system, text, maxTokens: 1500, temperature: 0.3 })
        const rawRules = safeParseJsonArray(out)

        if (!rawRules || !rawRules.length) {
          api.log.info(`[群友蒸馏] 群 ${groupId} 未解析出有效规则，回包片段: ${String(out).replace(/\s+/g, ' ').slice(0, 120)}`)
          return 0
        }

        const cleaned = verifyAndCleanRules(rawRules, lines)

        if (cleaned.length > 0) {
          const cap = api.settings().maxCapacity || 100
          const shareGlobal = api.settings().globalSharing !== false
          const targetScope = shareGlobal ? 'global' : groupId
          store.addRules(targetScope, cleaned, cap, { originGroup: groupId })
          api.log.info(`[群友蒸馏] 从群 ${groupId} 提炼合并 ${cleaned.length} 条口癖规则${shareGlobal ? '至全局公共底座' : '至专属群库'}`)
        }
        return cleaned.length
      } catch (err) {
        api.log.warn(`[群友蒸馏] 群 ${groupId} 提炼异常:`, err.message)
        return 0
      }
    }

    function cleanStyleText(style) {
      if (!style) return ''
      return String(style)
        .replace(/^(?:调侃)?(?:使用|用|说|回复|直接抛出|短句直说|直给短句)\s*/g, '')
        .replace(/(?:的反转句式|的超短句|句式|短句)$/g, '')
        .trim()
    }

    // 上下文注入：严格遵守门槛与精准命中，杜绝强行句式与小学生造句
    api.context(({ chat }) => {
      if (!chat || chat.kind !== 'group' || !isGroupActive(chat.groupId)) return ''

      const minCount = Number(api.settings().minPromotionCount) || 3
      const includeGlobal = api.settings().globalSharing !== false
      const activeRules = store.getActiveRules(chat.groupId, minCount, { includeGlobal })
      if (!activeRules.length) return ''

      const recentLines = recentChatCache.get(chat.groupId) || []
      const recentText = recentLines.map(m => m.text).join(' ')
      if (!recentText) return ''

      // 默认单次最多参考 1 条，避免强行给模型套多个紧箍咒
      const maxRules = Math.max(1, Math.min(Number(api.settings().maxInjectedRules) || 1, 2))
      const matched = store.matchRelevantRules(activeRules, recentText, maxRules)

      // 核心原则：绝不强行加戏！没有明确命中具体情境时，保持 Bot 自在松弛，一条都不注入
      if (!matched.length) {
        return ''
      }

      const hints = matched.map(r => {
        const sit = r.situation.replace(/^(?:当|在|聊到|遇到|说到)?/g, '').replace(/(?:时|的时候)$/g, '')
        const tone = cleanStyleText(r.style)
        return `聊到「${sit}」时群友常带的语调：${tone}`
      }).join('；')

      try {
        store.recordRuleUsage(chat.groupId, matched.map(r => r.id))
        api.log.info(`[群友蒸馏] 为群 ${chat.groupId} 命中语感参考: ${hints}`)
      } catch {}

      return `（群内氛围小贴士：${hints}。仅供感受说话节奏与松弛感，按你自己的性格自然说话即可，严禁生硬套用或背诵模板。）`
    })

    // 面板后端路由
    const readBody = async (req) => (api.core?.http?.body ? api.core.http.body(req) : (req?.body || req || {}))

    api.route('/status', async () => {
      const storeGroups = new Set(store.getAllGroupIds())
      for (const gid of buffers.keys()) {
        storeGroups.add(gid)
      }
      const historyStats = scanHistoryGroups(chatLogDir)
      for (const h of historyStats) {
        storeGroups.add(h.groupId)
      }

      const minCount = Number(api.settings().minPromotionCount) || 3
      const shareGlobal = api.settings().globalSharing !== false

      const globalRaw = store.getRawRules('global')
      const globalActive = store.getActiveRules('global', minCount, { includeGlobal: false })
      const globalCandidates = store.getCandidateRules('global', minCount, { includeGlobal: false })
      const globalItem = {
        groupId: 'global',
        groupName: '🌐 全局共享语感底座 (所有群继承)',
        isGlobal: true,
        isLiveActive: shareGlobal,
        totalCount: globalRaw.length,
        activeCount: globalActive.length,
        candidateCount: globalCandidates.length,
        lockedCount: globalRaw.filter(r => r.locked).length,
        bufferCount: 0,
        historyCount: 0,
      }

      const regularGroupIds = Array.from(storeGroups).filter(gid => gid !== 'global')
      const list = await Promise.all(regularGroupIds.map(async (gid) => {
        const raw = store.getRawRules(gid, { includeGlobal: false })
        const active = store.getActiveRules(gid, minCount, { includeGlobal: false })
        const candidates = store.getCandidateRules(gid, minCount, { includeGlobal: false })
        const buf = buffers.get(gid) || []
        const hStat = historyStats.find(h => h.groupId === gid)
        let groupName = gid
        try {
          groupName = (await api.core?.hub?.groupName?.(String(gid))) || gid
        } catch {}
        return {
          groupId: gid,
          groupName,
          isLiveActive: isGroupActive(gid),
          isGlobal: false,
          totalCount: raw.length,
          activeCount: active.length,
          inheritedCount: shareGlobal ? globalActive.length : 0,
          candidateCount: candidates.length,
          lockedCount: raw.filter(r => r.locked).length,
          bufferCount: buf.length,
          historyCount: hStat?.totalCount || 0,
        }
      }))

      list.sort((a, b) => {
        if (a.isLiveActive !== b.isLiveActive) return a.isLiveActive ? -1 : 1
        return (b.activeCount * 1000 + b.historyCount) - (a.activeCount * 1000 + a.historyCount)
      })
      return { ok: true, list: [globalItem, ...list], settings: api.settings() }
    })

    api.route('/rules', async (req) => {
      const q = api.core?.http?.query ? api.core.http.query(req) : {}
      const gid = q.groupId || new URL(req.url, 'http://localhost').searchParams.get('groupId')
      if (!gid) return { ok: false, message: '缺少 groupId' }
      const minCount = Number(api.settings().minPromotionCount) || 3
      const shareGlobal = api.settings().globalSharing !== false
      const isGlobal = gid === 'global'
      const includeGlobal = !isGlobal && shareGlobal

      const activeRules = store.getActiveRules(gid, minCount, { includeGlobal })
      const candidateRules = store.getCandidateRules(gid, minCount, { includeGlobal })
      return {
        ok: true,
        groupId: gid,
        isGlobal,
        globalSharing: shareGlobal,
        activeRules,
        candidateRules,
        minCount,
        totalCount: activeRules.length + candidateRules.length,
      }
    })

    api.route('/scope-rule', async (req) => {
      const body = await readBody(req)
      const { fromScope, toScope, ruleId } = body || {}
      if (!fromScope || !toScope || !ruleId) return { ok: false, message: '参数不足' }
      const success = store.scopeRule(fromScope, toScope, ruleId)
      return { ok: success, message: success ? '规则作用域已调整' : '规则流转失败' }
    })

    api.route('/promote', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      const { ruleId } = body || {}
      if (!scope || !ruleId) return { ok: false, message: '参数不足' }
      const minCount = Number(api.settings().minPromotionCount) || 3
      const success = store.promoteCandidate(scope, ruleId, minCount)
      return { ok: success }
    })

    api.route('/prune-noise', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      if (!scope) return { ok: false, message: '缺少 groupId 或 scope' }
      const pruned = store.pruneNoise(scope, 2)
      return { ok: true, pruned, message: `已清理 ${pruned} 条单次出现的偶发噪点` }
    })

    api.route('/consolidate', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      if (!scope) return { ok: false, message: '缺少 groupId 或 scope' }
      const reduced = store.consolidate(scope)
      return { ok: true, reduced, message: `近义规则聚类完成，精简了 ${reduced} 条重复规则` }
    })

    api.route('/toggle-lock', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      const { ruleId } = body || {}
      if (!scope || !ruleId) return { ok: false, message: '参数不足' }
      const locked = store.toggleLock(scope, ruleId)
      return { ok: true, locked }
    })

    api.route('/delete-rule', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      const { ruleId } = body || {}
      if (!scope || !ruleId) return { ok: false, message: '参数不足' }
      store.deleteRule(scope, ruleId)
      return { ok: true }
    })

    api.route('/add-manual', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      const { situation, style } = body || {}
      if (!scope || !situation || !style) return { ok: false, message: '情境和风格均不能为空' }
      store.addManualRule(scope, { situation, style })
      return { ok: true }
    })

    api.route('/clear-all', async (req) => {
      const body = await readBody(req)
      const scope = body?.scope || body?.groupId
      if (!scope) return { ok: false, message: '缺少 groupId 或 scope' }
      store.clearRules(scope)
      return { ok: true }
    })

    api.route('/trigger-now', async (req) => {
      const body = await readBody(req)
      const gid = body?.scope || body?.groupId
      if (!gid) return { ok: false, message: '缺少 groupId' }
      if (gid === 'global') {
        return { ok: false, message: '全局公共库由各群实时提炼自动汇聚，请选择具体群聊来触发缓存提炼' }
      }
      const buf = buffers.get(gid) || []
      if (buf.length < 2) {
        return { ok: false, message: `当前实时消息缓存仅 ${buf.length} 条，不足以提炼（建议等待群友发言或使用上方「从历史聊天提炼」）` }
      }
      const lines = buf.splice(0, buf.length)
      const count = await runDistillLines(gid, lines)
      return { ok: true, message: `已提炼 ${lines.length} 条实时发言，获得 ${count} 条新规则` }
    })

    api.route('/distill-history', async (req) => {
      const body = await readBody(req)
      const gid = body?.scope || body?.groupId
      const { days = 3, sampleSize = 35 } = body || {}
      if (!gid) return { ok: false, message: '缺少 groupId' }
      if (gid === 'global') {
        return { ok: false, message: '全局公共底座无需直接抽样，请选择具体群聊，提炼时将自动汇入全局底座' }
      }

      const botQQ = api.config?.()?.botQQ || ''
      const lines = sampleGroupHistory(chatLogDir, gid, {
        days: Number(days) || 3,
        sampleSize: Math.min(60, Math.max(10, Number(sampleSize) || 35)),
        botQQ,
      })

      if (lines.length < 5) {
        return { ok: false, message: `该群在指定时段内的有效群友发言仅 ${lines.length} 条，不足以提炼（至少需 5 条）` }
      }

      const count = await runDistillLines(gid, lines)
      return {
        ok: true,
        message: count > 0 
          ? `成功抽样 ${lines.length} 组历史发言，提炼合并出 ${count} 条语感规则！`
          : `成功分析 ${lines.length} 组发言，但未发现有代表性的特殊口癖（内容较常规或被过滤）`,
        sampleCount: lines.length,
        extractedCount: count,
      }
    })

    // 模拟测试回复效果接口（沙盒验证）
    api.route('/simulate', async (req) => {
      const body = await readBody(req)
      const gid = body?.scope || body?.groupId
      const { userText } = body || {}
      if (!gid || !userText?.trim()) return { ok: false, message: '缺少 groupId 或测试内容' }

      const minCount = Number(api.settings().minPromotionCount) || 3
      const includeGlobal = gid !== 'global' && api.settings().globalSharing !== false
      const activeRules = store.getActiveRules(gid, minCount, { includeGlobal })
      const maxRules = Number(api.settings().maxInjectedRules) || 2
      const matched = store.matchRelevantRules(activeRules, userText, maxRules)

      const hints = matched.map(r => {
        const sit = r.situation.replace(/时$/, '')
        return `当${sit}时，可以像群友一样这样说：${r.style}`
      }).join('；')

      const stylePrompt = hints ? `（当前群聊语感参考：${hints}。保持自身原本身份设定，自然带一点群友常说的调调即可，切勿生搬硬套模板或冒充他人经历。）` : ''
      const basePersona = api.core?.personas?.currentPersonaText?.() || '你是大肥鱼，一只性格活泼随和的数字生命。'
      const system = `${basePersona}\n\n${stylePrompt}`

      const reply = await api.ask({
        system,
        text: userText,
        maxTokens: 500,
        temperature: 0.7,
      })

      return {
        ok: true,
        matchedRules: matched,
        hit: matched.length > 0,
        stylePrompt,
        reply: reply || '（模型未输出文字）',
      }
    })

    return {
      getGroupRules: (gid) => store.getActiveRules(gid),
      clearGroupRules: (gid) => store.clearRules(gid),
      dispose: () => {
        buffers.clear()
        recentChatCache.clear()
      }
    }
  }
}
