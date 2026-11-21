import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const STOPWORDS = new Set(['情境', '口癖', '表达', '使用', '时候', '情况', '别人', '自己', '经常', '习惯'])

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
        return JSON.parse(text)
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
    getRawRules(groupId) {
      const data = load()
      return data.groups[groupId]?.rules || []
    },

    getRules(groupId) {
      return this.getRawRules(groupId)
    },

    /**
     * 获取正式生效的规则：必须已锁定 或 频次 >= minCount
     */
    getActiveRules(groupId, minCount = 3) {
      const all = this.getRawRules(groupId)
      return all.filter(r => r.locked || (r.count || 1) >= minCount)
    },

    /**
     * 获取候选观察中的规则：未锁定 且 频次 < minCount
     */
    getCandidateRules(groupId, minCount = 3) {
      const all = this.getRawRules(groupId)
      return all.filter(r => !r.locked && (r.count || 1) < minCount)
    },

    getAllGroupIds() {
      const data = load()
      return Object.keys(data.groups)
    },

    /**
     * 智能合并新提炼的规则（带语义聚类）：
     * 1. 与已有规则相近 -> 累加频次，刷新最近出现时间
     * 2. 全新规则 -> 作为候选存入（count = 1）
     * 3. 淘汰时优先保护锁定与高频规则
     */
    addRules(groupId, newRules, maxCapacity = 100) {
      const data = load()
      if (!data.groups[groupId]) {
        data.groups[groupId] = { rules: [] }
      }
      const list = data.groups[groupId].rules
      const now = Date.now()

      for (const nr of newRules) {
        // 使用模糊相似度查找已有相近规则
        const existing = list.find(r => areRulesSimilar(r, nr))
        if (existing) {
          existing.count = (existing.count || 1) + 1
          existing.lastSeenAt = now
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
        data.groups[groupId].rules = [...locked, ...unlocked.slice(0, keepCount)]
      }

      save(data)
    },

    /**
     * 聚类清洗现有规则：把已有的近义规则合并累加频次
     */
    consolidate(groupId) {
      const data = load()
      const rawList = data.groups[groupId]?.rules || []
      if (!rawList.length) return 0

      const merged = []
      for (const r of rawList) {
        const target = merged.find(m => areRulesSimilar(m, r))
        if (target) {
          target.count = (target.count || 1) + (r.count || 1)
          if (r.locked) target.locked = true
          if ((r.lastSeenAt || 0) > (target.lastSeenAt || 0)) target.lastSeenAt = r.lastSeenAt
          if ((r.injectedCount || 0) > 0) target.injectedCount = (target.injectedCount || 0) + r.injectedCount
        } else {
          merged.push({ ...r })
        }
      }

      const reduced = rawList.length - merged.length
      data.groups[groupId].rules = merged
      save(data)
      return reduced
    },

    /**
     * 清理一次性偶发噪点（删除未锁定且频次 < minCount 的规则）
     */
    pruneNoise(groupId, minCount = 2) {
      const data = load()
      const list = data.groups[groupId]?.rules || []
      const before = list.length
      data.groups[groupId].rules = list.filter(r => r.locked || (r.count || 1) >= minCount)
      const deleted = before - data.groups[groupId].rules.length
      save(data)
      return deleted
    },

    /**
     * 候选转正：手动将观察中的候选规则标记为正式生效（锁定）
     */
    promoteCandidate(groupId, ruleId, targetMinCount = 3) {
      const data = load()
      const rule = data.groups[groupId]?.rules?.find(r => r.id === ruleId)
      if (rule) {
        rule.locked = true
        rule.count = Math.max(rule.count || 1, targetMinCount)
        save(data)
        return true
      }
      return false
    },

    toggleLock(groupId, ruleId) {
      const data = load()
      const rule = data.groups[groupId]?.rules?.find(r => r.id === ruleId)
      if (rule) {
        rule.locked = !rule.locked
        save(data)
        return rule.locked
      }
      return false
    },

    deleteRule(groupId, ruleId) {
      const data = load()
      if (data.groups[groupId]) {
        data.groups[groupId].rules = data.groups[groupId].rules.filter(r => r.id !== ruleId)
        save(data)
      }
    },

    addManualRule(groupId, { situation, style }) {
      const data = load()
      if (!data.groups[groupId]) data.groups[groupId] = { rules: [] }
      const now = Date.now()
      data.groups[groupId].rules.unshift({
        id: Math.random().toString(36).slice(2, 10),
        situation,
        style,
        count: 5,
        createdAt: now,
        lastSeenAt: now,
        locked: true, // 手动录入的直接转正锁定
      })
      save(data)
    },

    clearRules(groupId) {
      const data = load()
      if (data.groups[groupId]) {
        data.groups[groupId].rules = []
        save(data)
      }
    },

    recordRuleUsage(groupId, ruleIds) {
      if (!ruleIds || !ruleIds.length) return
      const data = load()
      const list = data.groups[groupId]?.rules
      if (!list || !list.length) return
      const now = Date.now()
      let changed = false
      const idSet = new Set(ruleIds)
      for (const r of list) {
        if (idSet.has(r.id)) {
          r.injectedCount = (r.injectedCount || 0) + 1
          r.lastInjectedAt = now
          changed = true
        }
      }
      if (changed) save(data)
    },

    /**
     * 精准匹配当前对话语境：
     * 严格检查关键词重合度（得分必须 >= 2，至少命中一个情境核心词）
     * 绝不盲目兜底！未命中时返回 []，保持 Bot 原本说话风格
     */
    matchRelevantRules(rules, contextText, limit = 2) {
      if (!rules.length || !contextText) return []
      const scored = []

      for (const rule of rules) {
        let score = 0
        const sitKeywords = extractKeywords(rule.situation)
        for (const k of sitKeywords) {
          if (contextText.includes(k)) score += 2
        }
        const styleKeywords = extractKeywords(rule.style)
        for (const k of styleKeywords) {
          if (contextText.includes(k)) score += 1
        }
        // 门槛：至少命中一个情境核心词（score >= 2）
        if (score >= 2) {
          scored.push({ rule, score })
        }
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map(m => m.rule)
    }
  }
}
