/**
 * 健壮地从模型输出中提取 JSON 数组（兼容思维链 <think>、markdown 代码块、[id:x] 干扰与括号匹配）
 */
export function safeParseJsonArray(text) {
  if (!text || typeof text !== 'string') return []
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '')

  // 1. 尝试从 markdown 代码块提取
  const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim())
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        for (const k of ['rules', 'candidates', 'data', 'styles', 'items']) {
          if (Array.isArray(parsed[k])) return parsed[k]
        }
      }
    } catch {}
  }

  // 2. 找到第一个包含对象的 '['（即匹配 '[' 后面跟着 '{' 的位置），做严格括号配对
  const startIdx = clean.search(/\[\s*\{/)
  if (startIdx >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    let endIdx = -1

    for (let i = startIdx; i < clean.length; i++) {
      const char = clean[i]
      if (escape) {
        escape = false
        continue
      }
      if (char === '\\') {
        escape = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (char === '[') depth++
        else if (char === ']') {
          depth--
          if (depth === 0) {
            endIdx = i
            break
          }
        }
      }
    }

    if (endIdx > startIdx) {
      try {
        const slice = clean.slice(startIdx, endIdx + 1).trim()
        const parsed = JSON.parse(slice)
        if (Array.isArray(parsed)) return parsed
      } catch {}
    }
  }

  // 3. 尝试如果模型返回的是一个包装对象 { "rules": [...] }
  const objMatch = clean.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0].trim())
      for (const k of ['rules', 'candidates', 'data', 'styles', 'items']) {
        if (Array.isArray(obj[k])) return obj[k]
      }
    } catch {}
  }

  return []
}

export function verifyAndCleanRules(rawRules, lines) {
  if (!Array.isArray(rawRules)) return []
  const valid = []

  for (const item of rawRules) {
    if (!item || typeof item !== 'object') continue
    const situation = String(item.situation || '').trim()
    const style = String(item.style || '').trim()
    const sourceId = parseInt(item.source_id, 10)

    if (!situation || !style || isNaN(sourceId)) continue
    if (situation.length > 30 || style.length > 30) continue

    const idx = sourceId - 1
    if (idx < 0 || idx >= lines.length) continue

    // 铁律 1：溯源消息不能是 Bot 自己发的话（防止复读机循环自毒）
    if (lines[idx].isBot) continue

    // 铁律 2：防冒充群友第一人称经历（资产、封号、生平、现实事件）
    if (/我(被封|买过|在读|住|工作在|破产|阳了|确诊|结婚|离婚|考研|买房)/.test(style) ||
        /我(被封|买过|在读|住|工作在|破产|阳了|确诊|结婚|离婚|考研|买房)/.test(situation)) {
      continue
    }

    // 铁律 3：过滤无意义单字或纯标点
    if (style.length < 2 || situation.length < 2) continue

    valid.push({ situation, style })
  }

  return valid
}
