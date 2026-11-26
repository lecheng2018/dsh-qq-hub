import { createHash } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { characterName } from '../persona/identity-context.js'

export function createMemoryStyle({
  dsh, getConfig, personaText, log,
  styles, styleOf, setDerivedStyle,
  createGenerationSignal, generationOf, isActive,
}) {
  const personaGuard = () => {
    try {
      const t = String(personaText?.() || '')
      if (!t) return ''
      const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 80 && /禁止|不要|不许|不得|别成|别用|别刻意/.test(l))
      if (!lines.length) return ''
      return lines.slice(0, 12).join('\n')
    } catch { return '' }
  }

  function noteStyle(key, list, sourceFingerprint) {
    if (!isActive()) return
    setDerivedStyle(key, list, { sourceFingerprint })
  }

  async function learnSelfStyle(genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      if (!isActive()) return
      if (genSignal && !genSignal.isValid()) return
      // 只从私聊（qq:*）汇总自我风格，绝不把群聊（group:*）黑话混进全局 self 导致跨群串味。
      const pool = Object.entries(styles() || {}).filter(([key]) => key !== 'self' && !key.startsWith('group:')).flatMap(([, list]) => list)
      if (pool.length < 3) return
      const current = styleOf('self')
      const sourceFingerprint = createHash('sha256').update(JSON.stringify({ pool, current })).digest('hex')
      try {
        const charName = characterName('', getConfig())
        const guard = personaGuard()
        const system = `你是「${charName}」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。` + (guard ? ' 注意：下面这些人设硬性规则优先级最高，学到的说法不得与它冲突：' + guard : '')
        let arr = null
        for (let attempt = 0; attempt < 2; attempt++) {
          const out = await askModel(dsh, {
            cfg: getConfig(),
            // 语感沉淀是全局的，用全局那张卡的名字；换卡后不该继续以旧名字的口吻学说话。
            system,
            text: `【后台离线任务：总结自己养成的说话方式（非编程任务，切勿作为编码助手回复）】\n`
              + `你是「${charName}」。请从下面大家的说话习惯里，挑出你会自然带上的说话方式（口头禅、语气词、节奏），不超过 6 条，每条不超过 20 字，只输出 JSON 字符串数组（形如 ["短句回复", "偶尔用 hhh"]）。\n`
              + (guard ? `人设硬性规则（禁止违反）：\n${guard}\n` : '')
              + (attempt === 0 ? '' : '【重要纠正】上一次未返回合法 JSON 数组，这次只输出合法 JSON 数组。\n')
              + `\n已经养成的：\n${current.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}\n\n【任务要求】严格只输出合法的 JSON 数组（形如 ["...", "..."]），不超过 6 条，不要输出任何解释说明。`,
            maxTokens: 800,
            temperature: 0.3,
            signal: genSignal?.signal,
          })
          if (!isActive() || (genSignal && !genSignal.isValid())) return
          const match = String(out || '').match(/\[[\s\S]*\]/)
          if (match) {
            try {
              const parsed = JSON.parse(match[0])
              if (Array.isArray(parsed)) {
                arr = parsed.map((item) => String(typeof item === 'string' ? item : item?.text || '').trim()).filter(Boolean)
                break
              }
            } catch {}
          }
        }
        if (arr && arr.length) setDerivedStyle('self', arr, { sourceFingerprint })
        else if (arr === null) log.warn('沉淀说话方式失败：模型未返回合法 JSON 数组')
      } catch (error) {
        if (genSignal && !genSignal.isValid()) return
        log.warn('沉淀说话方式失败：', error.message)
      }
    } finally {
      task.cleanup()
    }
  }

  return { noteStyle, learnSelfStyle }
}
