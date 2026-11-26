import { randomUUID, createHash } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { parseReflection, hasReflectionJson } from './memory-core.js'
import { resolveCharacterIdentity } from '../persona/identity-context.js'

export function createMemoryReflection({
  dsh, getConfig, personaText, log,
  insightsOf, setDerivedInsights, styleOf, setStyle,
  createGenerationSignal, generationOf, isActive,
}) {
  const personaGuard = (chat = null) => {
    try {
      const t = String(personaText?.(chat) || '')
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
      // 群聊不做自动相处反思（易把多人技术/闲聊总结成客服说教 SOP）；私聊照常反思。
      if (chat?.kind === 'group') return 0
      const key = chat?.userId ? `qq:${chat.userId}` : ''
      if (!key || !isActive()) return 0
      if (genSignal && !genSignal.isValid()) return 0
      const old = insightsOf(key)
      const oldStyle = styleOf(key)
      const who = '对方'
      const charName = resolveCharacterIdentity(chat, getConfig()).name
      const guard = personaGuard(chat)
      const sourceFingerprint = createHash('sha256').update(String(transcript)).digest('hex')
      const system = `你是「${charName}」，在回顾自己和` + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + (guard ? '人设硬性规则（style 不得与它冲突；被禁止的标点、格式、长度，对方用得再多也不许学）：\n' + guard + '\n' : '')
        + '只输出这个 JSON 对象。'

      let out = ''
      let valid = false
      for (let attempt = 0; attempt < 2; attempt++) {
        const taskHead = `【后台离线任务：总结相处经验与说话方式（非编程任务，切勿作为编码助手或聊天角色回复）】\n`
          + `你是「${charName}」，正在回顾和${who}的聊天，提炼两类信息并严格只输出 JSON 对象 {"insights":[...],"style":[...]}：\n`
          + `- insights：可复用的相处之道（怎么相处更好，不记具体事实事件），合并去重后最多 8 条，每条不超过 30 字；\n`
          + `- style：${who}的说话习惯/用词风格/断句节奏（不写具体内容），最多 5 条，每条不超过 30 字。\n`
          + (guard ? `人设硬性规则（style 不得违反）：\n${guard}\n` : '')
          + (attempt === 0 ? '' : '【重要纠正】上一次回复不是合法 JSON。这次必须只输出 {"insights":[...],"style":[...]}，不要任何解释、问候或分析。\n')

        out = await askModel(dsh, {
          cfg: getConfig(),
          // 这个聊天实际用哪张卡，就问身份中枢要——换卡后回顾心得不能还署旧名字。
          system,
          text: `${taskHead}\n【已有经验】\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n`
            + `【已记下的说话方式】\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n`
            + `【最近的聊天记录流水】\n${transcript}\n\n`
            + `【输出要求】切勿续写或分析代码，直接输出唯一合法的 JSON 对象 {"insights":[...],"style":[...]}。`,
          maxTokens: 1500,
          temperature: 0.3,
          signal: genSignal?.signal,
        })
        if (!isActive() || (genSignal && !genSignal.isValid())) throw new Error('回顾任务已取消')
        if (hasReflectionJson(out)) {
          valid = true
          break
        }
        log?.debug?.(`相处经验 JSON 第 ${attempt + 1} 次解析失败：${String(out || '').replace(/\s+/g, ' ').slice(0, 120)}`)
      }
      if (!valid) {
        log?.warn?.(`总结和 ${key} 相处经验失败：模型未返回合法 JSON`)
        throw new Error('模型未返回有效的相处经验 JSON')
      }
      const { insights: rawIns, style: rawStyle } = parseReflection(out)
      if (rawStyle.length) setStyle(key, rawStyle, { sourceFingerprint })
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
