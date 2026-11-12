import { randomUUID, createHash } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { parseReflection } from './memory-core.js'

export function createMemoryReflection({
  dsh, getConfig, personaText, log,
  insightsOf, setDerivedInsights, styleOf, setStyle,
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

  async function reflect(chat, transcript, genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      const key = chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : ''
      if (!key || !isActive()) return 0
      if (genSignal && !genSignal.isValid()) return 0
      const old = insightsOf(key)
      const oldStyle = styleOf(key)
      const who = chat.kind === 'group' ? '这个群' : '对方'
      const sourceFingerprint = createHash('sha256').update(String(transcript)).digest('hex')
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
      if (!isActive() || (genSignal && !genSignal.isValid())) throw new Error('回顾任务已取消')
      const { insights: rawIns, style: rawStyle } = parseReflection(out)
      if (rawStyle.length) setStyle(key, rawStyle)
      const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
      if (!arr.length) return 0
      const now = Date.now()
      setDerivedInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '', { sourceFingerprint })
      log?.info?.(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
      return arr.length
    } finally {
      task.cleanup()
    }
  }

  return { reflect }
}
