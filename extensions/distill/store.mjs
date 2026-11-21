import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const GLOBAL_SCOPE = 'global'

const STOPWORDS = new Set([
  '情境', '口癖', '表达', '使用', '时候', '情况', '别人', '自己', '经常', '习惯',
  '遇到', '发生', '看到', '发现', '表示', '说明', '提出', '建议', '开始', '继续',
  '觉得', '如果', '怎么', '这样', '那样', '这个', '那个', '一个', '一下', '有点',
  '真的', '确实', '好像', '其实', '大家', '有人', '群友', '我们', '你们', '他们',
  '什么', '为什么', '怎么会', '可以', '可能', '就是', '不是', '还是', '直接', '然后',
  '很多', '一些', '所有'
])

/**
 * 中文关键词/2-gram 分词提取（用于情境与语境的灵活语义匹配）
 */
export function extractKeywords(str) {
  if (!str) return []
  const clean = str.replace(/^(?:当|在)?/g, '').replace(/(?:时|的时候)$/g, '')
  const parts = clean.split(/[，,。、\s\/\-_]+/).filter(Boolean)
  const keywords = new Set()

  for (const p of parts) {
    if (p.length >= 2 && !STOPWORDS.has(p)) keywords.add(p)
    // 2-gram 拆解（中文双字词窗）
    for (let i = 0; i <= p.length - 2; i++) {
      const sub = p.slice(i, i + 2)
      if (sub.length === 2 && !STOPWORDS.has(sub)) {
        keywords.add(sub)
      }
    }
  }
  return Array.from(keywords)
}

/**
 * 判定两条规则是否属于同一情境/口癖的近义重复
 */
export function areRulesSimilar(r1, r2) {
  if (!r1 || !r2) return false
  if (r1.situation === r2.situation && r1.style === r2.style) return true

  const k1 = extractKeywords(r1.situation)
  const k2 = extractKeywords(r2.situation)
  const commonSit = k1.filter(w => k2.includes(w) && w.length >= 2)

  const s1 = extractKeywords(r1.style)
  const s2 = extractKeywords(r2.style)
  const commonStyle = s1.filter(w => s2.includes(w) && w.length >= 2)

  // 情境和表达均有非停用词的实质关键词交集，判定为同一类规则
  return commonSit.length >= 1 && commonStyle.length >= 1
}

export function createDistillStore(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const filePath = join(dataDir, 'distill-rules.json')

  function load() {
    try {
      if (existsSync(filePath)) {
        const text = readFileSync(filePath, 'utf8')
        const data = JSON.parse(text)
        if (!data.groups) data.groups = {}
        return data
      }
    } catch (e) {
      console.warn('[distill] 读取规则库失败，使用默认空库:', e.message)
    }
    return { groups: {} }
  }

  function save(data) {
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (e) {
      console.error('[distill] 保存规则库失败:', e.message)
    }
  }

  return {
    /**
     * 获取指定作用域下的规则列表。
     * 当 groupId !== 'global' 且 includeGlobal 为 true 时，自动合并全局公共规则与本群专属规则。
     */
    getRawRules(groupId, { includeGlobal = false } = {}) {
      const data = load()
      if (groupId === GLOBAL_SCOPE) {
        return (data.groups[GLOBAL_SCOPE]?.rules || []).map(r => ({
          ...r,
          scope: GLOBAL_SCOPE,
          isGlobal: true,
        }))
      }

      const localRules = (data.groups[groupId]?.rules || []).map(r => ({
        ...r,
        scope: groupId,
        isGlobal: false,
      }))

      if (!includeGlobal) {
        return localRules
      }

      const globalRules = (data.groups[GLOBAL_SCOPE]?.rules || []).map(r => ({
        ...r,
        scope: GLOBAL_SCOPE,
        isGlobal: true,
      }))

      // 本群专属规则优先：若本地已有近义规则，以本地定义为准，其余全局规则全部继承
      const inheritedGlobal = globalRules.filter(gr => !localRules.some(lr => areRulesSimilar(lr, gr)))
      return [...localRules, ...inheritedGlobal]
    },

    getRules(groupId, options) {
      return this.getRawRules(groupId, options)
    },

    /**
     * 获取正式生效的规则：必须已锁定 或 频次 >= minCount
     * 默认包含继承自全局底座的正式规则
     */
    getActiveRules(groupId, minCount = 3, { includeGlobal = true } = {}) {
      const all = this.getRawRules(groupId, { includeGlobal })
      return all.filter(r => r.locked || (r.count || 1) >= minCount)
    },

    /**
     * 获取候选观察中的规则：未锁定 且 频次 < minCount
     */
    getCandidateRules(groupId, minCount = 3, { includeGlobal = true } = {}) {
      const all = this.getRawRules(groupId, { includeGlobal })
      return all.filter(r => !r.locked && (r.count || 1) < minCount)
    },

    getAllGroupIds() {
      const data = load()
      return Object.keys(data.groups)
    },

    /**
     * 智能合并新提炼的规则（带语义聚类）：
     * @param {string} targetScope 目标作用域（'global' 或 具体群号）
     * @param {Array} newRules 新提炼的规则
     * @param {number} maxCapacity 容量上限
     * @param {object} options 附加选项（如 originGroup: 来源群号）
     */
    addRules(targetScope, newRules, maxCapacity = 100, { originGroup = '' } = {}) {
      const data = load()
      const scope = targetScope || GLOBAL_SCOPE
      if (!data.groups[scope]) {
        data.groups[scope] = { rules: [] }
      }
      const list = data.groups[scope].rules
      const now = Date.now()

      for (const nr of newRules) {
        // 使用模糊相似度查找已有相近规则
        const existing = list.find(r => areRulesSimilar(r, nr))
        if (existing) {
          existing.count = (existing.count || 1) + 1
          existing.lastSeenAt = now
          if (originGroup) {
            existing.sourceGroups = Array.from(new Set([...(existing.sourceGroups || []), originGroup]))
          }
          // 若新提取的描述更长更具体且未锁定，适度更新
          if (nr.style.length > existing.style.length && !existing.locked) {
            existing.style = nr.style
          }
        } else {
          list.push({
            id: Math.random().toString(36).slice(2, 10),
            situation: nr.situation,
            style: nr.style,
            count: 1,
            createdAt: now,
            lastSeenAt: now,
            locked: false,
            scope,
            originGroup: originGroup || scope,
            sourceGroups: originGroup ? [originGroup] : [scope],
          })
        }
      }

      // 超出上限时：锁定优先，高频次优先，最近出现优先
      if (list.length > maxCapacity) {
        const locked = list.filter(r => r.locked)
        const unlocked = list.filter(r => !r.locked)

        unlocked.sort((a, b) => {
          const countDiff = (b.count || 1) - (a.count || 1)
          if (countDiff !== 0) return countDiff
          const timeDiff = (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
          if (timeDiff !== 0) return timeDiff
          return (b.createdAt || 0) - (a.createdAt || 0)
        })

        const keepCount = Math.max(0, maxCapacity - locked.length)
        data.groups[scope].rules = [...locked, ...unlocked.slice(0, keepCount)]
      }

      save(data)
    },

    /**
     * 规则作用域流转：在全局共享库与本群专属库之间迁移/复制
     * @param {string} fromScope 源作用域 ('global' 或 群号)
     * @param {string} toScope 目标作用域 ('global' 或 群号)
     * @param {string} ruleId 规则 ID
     */
    scopeRule(fromScope, toScope, ruleId) {
      if (!fromScope || !toScope || fromScope === toScope) return false
      const data = load()
      const fromList = data.groups[fromScope]?.rules || []
      const idx = fromList.findIndex(r => r.id === ruleId)
      if (idx === -1) return false

      const [targetRule] = fromList.splice(idx, 1)
      if (!data.groups[toScope]) data.groups[toScope] = { rules: [] }
      const toList = data.groups[toScope].rules

      targetRule.scope = toScope
      targetRule.lastSeenAt = Date.now()

      // 若目标库中已有相近规则，直接合并频次
      const existing = toList.find(r => areRulesSimilar(r, targetRule))
      if (existing) {
        existing.count = (existing.count || 1) + (targetRule.count || 1)
        if (targetRule.locked) existing.locked = true
      } else {
        toList.unshift(targetRule)
      }

      save(data)
      return true
    },

    /**
     * 聚类清洗现有规则：把已有的近义规则合并累加频次
     */
    consolidate(scope) {
      const data = load()
      const rawList = data.groups[scope]?.rules || []
      if (!rawList.length) return 0

      const merged = []
      for (const r of rawList) {
        const target = merged.find(m => areRulesSimilar(m, r))
        if (target) {
          target.count = (target.count || 1) + (r.count || 1)
          if (r.locked) target.locked = true
          if ((r.lastSeenAt || 0) > (target.lastSeenAt || 0)) target.lastSeenAt = r.lastSeenAt
          if ((r.injectedCount || 0) > 0) target.injectedCount = (target.injectedCount || 0) + r.injectedCount
          if (r.sourceGroups) {
            target.sourceGroups = Array.from(new Set([...(target.sourceGroups || []), ...r.sourceGroups]))
          }
        } else {
          merged.push({ ...r })
        }
      }

      const reduced = rawList.length - merged.length
      data.groups[scope].rules = merged
      save(data)
      return reduced
    },

    /**
     * 清理一次性偶发噪点（删除未锁定且频次 < minCount 的规则）
     */
    pruneNoise(scope, minCount = 2) {
      const data = load()
      const list = data.groups[scope]?.rules || []
      const before = list.length
      data.groups[scope].rules = list.filter(r => r.locked || (r.count || 1) >= minCount)
      const deleted = before - data.groups[scope].rules.length
      save(data)
      return deleted
    },

    /**
     * 候选转正：手动将观察中的候选规则标记为正式生效（锁定）
     */
    promoteCandidate(scope, ruleId, targetMinCount = 3) {
      const data = load()
      // 支持直接指定 scope 或遍历查找
      let targetList = data.groups[scope]?.rules
      let rule = targetList?.find(r => r.id === ruleId)

      if (!rule) {
        for (const [s, grp] of Object.entries(data.groups)) {
          const found = grp.rules?.find(r => r.id === ruleId)
          if (found) {
            rule = found
            targetList = grp.rules
            break
          }
        }
      }

      if (rule) {
        rule.locked = true
        rule.count = Math.max(rule.count || 1, targetMinCount)
        save(data)
        return true
      }
      return false
    },

    toggleLock(scope, ruleId) {
      const data = load()
      let rule = data.groups[scope]?.rules?.find(r => r.id === ruleId)
      if (!rule) {
        for (const grp of Object.values(data.groups)) {
          const found = grp.rules?.find(r => r.id === ruleId)
          if (found) { rule = found; break }
        }
      }
      if (rule) {
        rule.locked = !rule.locked
        save(data)
        return rule.locked
      }
      return false
    },

    deleteRule(scope, ruleId) {
      const data = load()
      if (data.groups[scope]) {
        data.groups[scope].rules = data.groups[scope].rules.filter(r => r.id !== ruleId)
        save(data)
        return
      }
      for (const grp of Object.values(data.groups)) {
        if (grp.rules?.some(r => r.id === ruleId)) {
          grp.rules = grp.rules.filter(r => r.id !== ruleId)
          save(data)
          return
        }
      }
    },

    addManualRule(scope, { situation, style }) {
      const data = load()
      const target = scope || GLOBAL_SCOPE
      if (!data.groups[target]) data.groups[target] = { rules: [] }
      const now = Date.now()
      data.groups[target].rules.unshift({
        id: Math.random().toString(36).slice(2, 10),
        situation,
        style,
        count: 5,
        createdAt: now,
        lastSeenAt: now,
        locked: true, // 手动录入的直接转正锁定
        scope: target,
        originGroup: target,
        sourceGroups: [target],
      })
      save(data)
    },

    clearRules(scope) {
      const data = load()
      if (data.groups[scope]) {
        data.groups[scope].rules = []
        save(data)
      }
    },

    recordRuleUsage(groupId, ruleIds) {
      if (!ruleIds || !ruleIds.length) return
      const data = load()
      const now = Date.now()
      let changed = false
      const idSet = new Set(ruleIds)

      // 命中可能来自本群专属，也可能来自全局底座
      const targets = [data.groups[groupId]?.rules, data.groups[GLOBAL_SCOPE]?.rules].filter(Boolean)
      for (const list of targets) {
        for (const r of list) {
          if (idSet.has(r.id)) {
            r.injectedCount = (r.injectedCount || 0) + 1
            r.lastInjectedAt = now
            changed = true
          }
        }
      }
      if (changed) save(data)
    },

    /**
     * 精准匹配当前对话语境：
     * 严格检查非虚词情境实词重合度
     * 绝不盲目兜底！未命中时返回 []，保持 Bot 原本说话风格
     */
    matchRelevantRules(rules, contextText, limit = 1) {
      if (!rules.length || !contextText) return []
      const scored = []

      for (const rule of rules) {
        let score = 0
        const sitKeywords = extractKeywords(rule.situation)
        let hitSitCount = 0
        for (const k of sitKeywords) {
          if (contextText.includes(k)) {
            score += 2
            hitSitCount++
          }
        }
        // 门槛：必须至少命中一个实质情境词（拒绝零情境匹配）
        if (hitSitCount < 1) continue

        const styleKeywords = extractKeywords(rule.style)
        for (const k of styleKeywords) {
          if (contextText.includes(k)) score += 1
        }

        if (score >= 2) {
          scored.push({ rule, score })
        }
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map(m => m.rule)
    }
  }
}
