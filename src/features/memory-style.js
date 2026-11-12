import { createHash } from 'node:crypto'
import { askModel } from '../core/llm.js'

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
      const pool = Object.entries(styles() || {}).filter(([key]) => key !== 'self').flatMap(([, list]) => list)
      if (pool.length < 3) return
      const current = styleOf('self')
      const sourceFingerprint = createHash('sha256').update(JSON.stringify({ pool, current })).digest('hex')
      try {
        const out = await askModel(dsh, {
          cfg: getConfig(),
          system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。' + (personaGuard() ? ' 注意：下面这些人设硬性规则优先级最高，学到的说法不得与它冲突：' + personaGuard() : ''),
          text: `已经养成的：\n${current.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
          maxTokens: 800,
          temperature: 0.3,
          signal: genSignal?.signal,
        })
        if (!isActive() || (genSignal && !genSignal.isValid())) return
        const match = out.match(/\[[\s\S]*\]/)
        const arr = match ? JSON.parse(match[0]).map((item) => String(typeof item === 'string' ? item : item?.text || '')) : []
        if (arr.length) setDerivedStyle('self', arr, { sourceFingerprint })
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
