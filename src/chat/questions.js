// 交互式提问（User Questions / ask_user_question）状态机与消息卡片系统
//
// 当模型需要人类决策或多选交互（如 ask_user_question 工具）时：
// 1. 将问题与选项排版为带 A./B./C. 字母与编号的 QQ 消息卡片发出；
// 2. 挂起当前会话等待人类作答；
// 3. 接收并解析用户回复（支持字母、数字编号、多选 A,C、模糊匹配及自定义输入）；
// 4. 将标准答案结构回填给 DSH，恢复 agent 执行。

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 将单个问题与选项格式化为 QQ 消息展示文本
 * @param {object} q 问题对象 { id, question, detail, header, options, multiSelect, intent }
 * @param {object} [meta] 辅助信息 { index, total }
 */
export function formatQuestionCard(q, { index = 1, total = 1 } = {}) {
  const parts = []
  const titleTag = total > 1 ? `（第 ${index}/${total} 问）` : ''
  const typeTag = q.multiSelect ? '【多选题】' : '【单选题】'
  const header = q.header ? `[${q.header}] ` : ''

  parts.push(`❓ AI 需要你确认${titleTag}：`)
  parts.push(`${typeTag} ${header}${String(q.question || '').trim()}`)

  if (q.detail) {
    const detail = String(q.detail).trim()
    if (detail) {
      parts.push(`\n📝 补充说明：\n${detail}`)
    }
  }

  const options = Array.isArray(q.options) ? q.options : []
  if (options.length > 0) {
    parts.push('\n选项列表：')
    options.forEach((opt, idx) => {
      const letter = LETTERS[idx] || `${idx + 1}`
      const label = String(opt.label || '').trim()
      const desc = opt.description ? ` (${opt.description.trim()})` : ''
      parts.push(`  ${letter}. ${label}${desc}`)
    })

    if (q.multiSelect) {
      parts.push('\n💡 回复方式：回复字母如 A 或 A,C；也可输入编号或文字')
    } else {
      parts.push('\n💡 回复方式：回复字母如 A 或编号 1；也可直接输入自定义回答')
    }
  } else {
    parts.push('\n💡 请直接回复你的回答')
  }

  return parts.join('\n')
}

/**
 * 将多道问题格式化为一个批次卡片
 */
export function formatBatchQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return ''
  return questions.map((q, idx) => formatQuestionCard(q, { index: idx + 1, total: questions.length })).join('\n\n━━━━━━━━━━━━━━\n\n')
}

/**
 * 解析用户的回答文本，匹配选项或返回自定义输入
 * @param {string} text 用户输入的文字
 * @param {object} question 问题对象
 * @returns {{ selected: string[], custom?: string }}
 */
export function parseUserAnswer(text, question) {
  const raw = String(text || '').trim()
  if (!raw) return { selected: [] }

  const options = Array.isArray(question.options) ? question.options : []
  if (options.length === 0) {
    // 没有预设选项，纯文本回答
    return { selected: [], custom: raw }
  }

  // 清洗输入：去掉前缀「选」、「我选」、「选择」
  const clean = raw.replace(/^(?:我?选(?:择)?|答案(?:是|为)?[:：]?)\s*/i, '').trim()

  // 1. 尝试按字母或数字分隔匹配（针对 A, B 或 1 2 这种）
  // 分隔符包含逗号、顿号、空格、分号、斜杠、加号、全角符号
  const tokens = clean.split(/[,，、\s;；\/+＋]+/).filter(Boolean)

  const selectedSet = new Set()
  const matchedTokens = new Set()

  for (const token of tokens) {
    const t = token.trim()
    if (!t) continue

    // 检查是否是单字母 A~Z
    if (t.length === 1 && /^[a-zA-Z]$/.test(t)) {
      const idx = LETTERS.indexOf(t.toUpperCase())
      if (idx >= 0 && idx < options.length) {
        selectedSet.add(options[idx].label)
        matchedTokens.add(token)
        continue
      }
    }

    // 检查是否是纯连写字母，如 "AB" 或 "ac"
    if (t.length > 1 && /^[a-zA-Z]+$/.test(t)) {
      let allMatch = true
      const subLabels = []
      for (const ch of t) {
        const idx = LETTERS.indexOf(ch.toUpperCase())
        if (idx >= 0 && idx < options.length) {
          subLabels.push(options[idx].label)
        } else {
          allMatch = false
          break
        }
      }
      if (allMatch && subLabels.length > 0) {
        subLabels.forEach((l) => selectedSet.add(l))
        matchedTokens.add(token)
        continue
      }
    }

    // 检查是否是数字编号 1, 2, 3...
    if (/^\d+$/.test(t)) {
      const num = parseInt(t, 10)
      if (num >= 1 && num <= options.length) {
        selectedSet.add(options[num - 1].label)
        matchedTokens.add(token)
        continue
      }
    }

    // 检查是否精确匹配选项 label
    const exact = options.find((o) => String(o.label || '').trim().toLowerCase() === t.toLowerCase())
    if (exact) {
      selectedSet.add(exact.label)
      matchedTokens.add(token)
      continue
    }
  }

  // 2. 如果分词没完全匹配，且整段文字精确等于某个选项文本
  if (selectedSet.size === 0) {
    const exactWhole = options.find((o) => String(o.label || '').trim().toLowerCase() === clean.toLowerCase())
    if (exactWhole) {
      return { selected: [exactWhole.label] }
    }
  }

  // 3. 模糊前缀匹配（如用户输入了选项的部分核心词）
  if (selectedSet.size === 0) {
    const prefixHit = options.find((o) => {
      const lbl = String(o.label || '').trim().toLowerCase()
      return lbl && (clean.toLowerCase().includes(lbl) || (clean.length >= 2 && lbl.includes(clean.toLowerCase())))
    })
    if (prefixHit) {
      return { selected: [prefixHit.label] }
    }
  }

  // 4. 处理最终结果
  const selected = [...selectedSet]
  if (selected.length > 0) {
    // 如果是单选题，且误选了多个，只取第一个
    if (!question.multiSelect && selected.length > 1) {
      return { selected: [selected[0]] }
    }
    // 检查是否有未识别的残留文本作为补充说明
    const leftover = tokens.filter((t) => !matchedTokens.has(t)).join(' ').trim()
    return leftover ? { selected, custom: leftover } : { selected }
  }

  // 5. 如果选项未命中任何选项，作为自定义 custom 回答
  return { selected: [], custom: raw }
}

/**
 * 创建提问登记器与状态机
 */
export function createQuestionRegistry({ deliver, timeoutMs = 300_000, log } = {}) {
  // chatId → { questions, resolve, reject, timer, createdAt, sessionId }
  const pending = new Map()

  /**
   * 检查指定聊天是否有挂起的提问
   */
  function has(chatId) {
    return pending.has(chatId)
  }

  /**
   * 注册提问请求，返回等待作答的 Promise
   * @param {string} chatId 目标聊天 ID (如 private:123456 或 group:789012)
   * @param {object} req DSH 提问请求 { questions, agent, signal }
   * @returns {Promise<{ answers: Array<{ id: string, selected: string[], custom?: string }> }>}
   */
  async function ask(chatId, req) {
    const questions = Array.isArray(req.questions) ? req.questions : []
    if (questions.length === 0) {
      throw new Error('提问请求必须包含至少一个问题')
    }

    // 若当前会话已有未完成提问，先将其取消
    if (pending.has(chatId)) {
      cancel(chatId, '收到新的提问请求，旧提问已失效')
    }

    const cardText = formatBatchQuestions(questions)
    const sessionId = req.agent?.session?.id || req.agent?.id || ''

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(chatId)) return
        pending.delete(chatId)
        log?.warn?.(`[questions] 提问超时 (${chatId}): ${questions.map((q) => q.question).join('; ')}`)
        // 超时给出默认空答案回填，不让模型永久挂死
        resolve({
          answers: questions.map((q) => ({ id: q.id, selected: [] }))
        })
        if (typeof deliver === 'function') {
          deliver(chatId, '⏰ 提问已超时（5分钟未答），已跳过本次提问继续执行。').catch(() => {})
        }
      }, timeoutMs)

      // 如果外部 signal abort 了
      if (req.signal) {
        req.signal.addEventListener('abort', () => {
          if (!pending.has(chatId)) return
          pending.delete(chatId)
          clearTimeout(timer)
          reject(new Error('提问已被中止'))
        }, { once: true })
      }

      pending.set(chatId, {
        chatId,
        sessionId,
        questions,
        resolve,
        reject,
        timer,
        createdAt: Date.now()
      })

      // 即刻投递提问卡片
      if (typeof deliver === 'function') {
        Promise.resolve(deliver(chatId, cardText)).catch((error) => {
          log?.warn?.(`[questions] 发送提问卡片失败 (${chatId}):`, error.message)
        })
      }
    })
  }

  /**
   * 处理用户在 QQ 里的回复消息
   * @param {string} chatId
   * @param {string} text
   * @returns {boolean} 是否被提问状态机消费
   */
  function handleReply(chatId, text) {
    const entry = pending.get(chatId)
    if (!entry) return false

    pending.delete(chatId)
    clearTimeout(entry.timer)

    try {
      const rawText = String(text || '').trim()
      const answers = []

      // 目前大模型每次提问多数是 1 个问题，若是多个问题，一次回复先解析给第 1 题
      entry.questions.forEach((q, idx) => {
        if (idx === 0) {
          const parsed = parseUserAnswer(rawText, q)
          answers.push({ id: q.id, ...parsed })
        } else {
          answers.push({ id: q.id, selected: [] })
        }
      })

      log?.info?.(`[questions] 收到提问答案 (${chatId}):`, JSON.stringify(answers))
      entry.resolve({ answers })

      // 回复一条即时提示给用户
      if (typeof deliver === 'function') {
        const first = answers[0]
        const choiceText = first.selected.length ? `[${first.selected.join(', ')}]` : (first.custom ? `"${first.custom}"` : '已提交')
        deliver(chatId, `✅ 收到回答 ${choiceText}，AI 继续处理中...`).catch(() => {})
      }
      return true
    } catch (error) {
      log?.warn?.(`[questions] 解析用户答案出错:`, error.message)
      entry.reject(error)
      return true
    }
  }

  /**
   * 取消提问
   */
  function cancel(chatId, reason = '提问已取消') {
    const entry = pending.get(chatId)
    if (!entry) return false
    pending.delete(chatId)
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
    return true
  }

  /**
   * 取消指定 session 的挂起
   */
  function cancelBySession(sessionId, reason = '会话重置') {
    for (const [chatId, entry] of pending.entries()) {
      if (entry.sessionId === sessionId) {
        cancel(chatId, reason)
      }
    }
  }

  function dispose(reason = '提问服务已卸载') {
    for (const chatId of [...pending.keys()]) cancel(chatId, reason)
  }

  return {
    ask,
    has,
    handleReply,
    cancel,
    cancelBySession,
    dispose,
    pendingCount: () => pending.size
  }
}
