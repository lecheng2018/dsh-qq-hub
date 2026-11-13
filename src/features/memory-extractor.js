import { askModel } from '../core/llm.js'
import { whenText, clarityOf, shouldForget } from './memory-core.js'
import { chatLogCursor, chatLogOffset } from '../chat/chat-log.js'
import { extractionBatchOf } from './memory-extraction.js'
import { parseJsonArray } from './json-array.js'

export const RETRY_BASE_MS = 60_000
export const MAX_ATTEMPTS = 4

function nextRetryAt(previous) {
  return previous?.nextRetryAt ?? (Number(previous?.at || 0) + RETRY_BASE_MS * 2 ** Math.max(0, Number(previous?.attempts || 1) - 1))
}

export function createMemoryExtractor({ dsh, getConfig, relatedTo, commit, isActive, reflect, batchState, scopeOf, recoveryError, log, consolidation }) {
  let consolidationBusy = false
  const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  async function extractFacts(chatId, transcript, genSignal = null) {
    if (!isActive()) return 0
    if (genSignal && !genSignal.isValid()) return 0
    const cfg = getConfig()
    const source = chatId === 'qzone' ? '下面是 QQ 空间里的动态（好友发的说说、别人给你的评论、你的回复）' : '下面是一段聊天'
    const related = relatedTo(chatId, transcript)
    const known = new Map(related.map((item) => [item.id, item]))
    let out = ''
    try {
      out = await askModel(dsh, {
        cfg,
        system: `你帮一个叫「大肥鱼」的聊天角色整理长期记忆。${source}，说话人后面括号里是 QQ 号。QQ 号是 ${cfg.ownerQQ} 的人是她的${cfg.ownerName || '主人'}。

记什么（三类）：
1. 人：别人的名字/称呼/身份/关系，喜好和讨厌的东西，雷区和禁忌，近况变化，你们之间的约定。
2. 她自己攒下的经验教训：踩过的坑、验证过的方法、定下的规矩。
3. 从看过的内容里学到的可复用知识：结论 + 适用条件 + 出处（哪个视频、哪篇文章、谁转述的）。这类要记，但要记成能直接用的结论，不是「看过某视频」。

不记：寒暄、日常琐事、一次性问答、没人再提的闲聊；不记她自己的人设和喜好（她本来就知道）；不记「今天看了什么」这种浏览流水，只记从里面学到的东西。

怎么写：
- 一条 30 到 60 字，写成一句自然的话，带一个具体细节（数字、店名、原话片段、命令、路径）。
- 句子本身要说清是谁说的、关于谁，不许用「有人」「群友」「他们」这种模糊主语。别人转述的写清转述关系。
- 不要字段标签（gist=、detail=、why=）、不要小标题、不要分点，就是一句人话。
- 正例：「小明不吃香菜，上次点菜挑了十分钟，点外卖记得问他」
- 正例：「NAS 选盘别碰杂牌混发，企业盘优先，这是 B 站那个搭 RAID 的视频里讲的」
- 反例：「小明.饮食：gist=不吃香菜；detail=挑十分钟；why=点外卖注意」
- 反例：「在B站看了《选硬盘搭RAID建Docker》这个视频」` +
        (related.length ? '\n每条新事实先和「已经记得的事」比一比：全新的写 "op":"add"；是对某条旧记忆的补充或更准确的说法，写 "op":"update"、"id" 填那条的编号、"text" 写合并后的完整说法；和某条旧记忆矛盾、说明那条已经过时（比如以前喜欢现在不喜欢了、换了工作、搬家了、分手了），写 "op":"outdated"、"id" 填旧的编号、"text" 写现在的新事实。拿不准是不是矛盾就当 add；已经记得、没有新信息的不要输出。' : '') +
        `只输出 JSON 数组，例如 [{"op":"add","text":"小明不吃香菜，上次点菜挑了十分钟，点外卖记得问他","about":"小明","about_qq":"12345","importance":0.6,"tags":["口味"]}]，tags 可选、最多两个短词，没有值得记的就输出 []。`,
        text: (related.length ? `已经记得的事：\n${related.map((item) => `#${item.id} [${whenText(item.at)}] ${item.aboutName ? '[' + item.aboutName + '] ' : ''}${item.text}`).join('\n')}\n\n` : '') + transcript,
        maxTokens: 3000,
        temperature: 0.2,
        signal: genSignal?.signal,
      })
    } catch (error) {
      if (genSignal && !genSignal.isValid()) return 0
      throw error
    }
    if (!isActive() || (genSignal && !genSignal.isValid())) return 0
    const { entries, truncated } = parseJsonArray(out)
    let added = 0
    try {
      for (const item of entries.slice(0, 12)) {
        if (!item || !item.text) continue
        if (/^(我|大肥鱼)/.test(String(item.about || '')) || String(item.about || '') === '大肥鱼') continue
        const qq = String(item.about_qq ?? '').replace(/\D/g, '')
        const about = qq.length >= 5 && qq !== String(cfg.botQQ) ? qq : chatId.startsWith('private:') ? chatId.slice(8) : ''
        if (await commit(item, { chatId, cfg, known, about })) added++
      }
    } catch (error) {
      error.factsCommitted = added
      throw error
    }
    if (truncated) {
      const error = new Error('模型输出截断，已保留完整条目，批次仍需重试')
      error.partial = true
      error.factsCommitted = added
      throw error
    }
    return added
  }

  async function extractLines(chatId, lines, genSignal = null) {
    if (!isActive()) return { ok: false, message: '记忆模块已关闭', added: 0, insights: 0 }
    if (recoveryError()) return { ok: false, message: recoveryError(), added: 0, insights: 0 }
    if (genSignal && !genSignal.isValid()) return { ok: false, message: '任务已取消', added: 0, insights: 0 }
    const talk = lines.filter((line) => line.text && !String(line.text).startsWith('【系统'))
    const isQzone = chatId === 'qzone'
    if (talk.filter((line) => line.who !== 'bot').length < (isQzone ? 1 : 6)) return { ok: true, skipped: true, message: '内容太少', added: 0, insights: 0 }
    const nonBot = talk.filter((line) => line.who !== 'bot')
    if (!isQzone && nonBot.length <= 12) {
      const substantive = nonBot.filter((line) => {
        const text = String(line.text).trim()
        if (text.length >= 12) return true
        return !/^(早|晚上好|中午好|早安|晚安|哈+|嘿+|嗯+|哦+|在吗|在|来了|吃了吗|睡了|哈哈+|呵呵|666+|好滴|好的|OK|ok|行|嗯嗯|诶|欸|？|\?|~|…|。)+[~！!。～\s]*$/.test(text)
      })
      if (!substantive.length) return { ok: true, skipped: true, message: '都是寒暄，没什么可记', added: 0, insights: 0 }
    }
    const formatLine = (line) => (line.who === 'bot' ? '我' : line.uid ? `${line.who}(${line.uid})` : line.who) + '：' + line.text
    let added = 0
    try {
      const chunks = []
      for (let index = 0; index < talk.length; index += 80) chunks.push(talk.slice(index, index + 80))
      for (const [index, part] of chunks.entries()) {
        if (genSignal && !genSignal.isValid()) throw new Error('提炼任务已取消')
        const batch = extractionBatchOf(chatId, index, part)
        const previous = batchState.get(batch.id)
        if (previous?.fingerprint && previous.fingerprint !== batch.fingerprint) throw new Error(`提炼批次 ${batch.id} 的输入已变化，请核对后重试`)
        if (previous?.status === 'done') { added += Number(previous.added) || 0; continue }
        if (previous?.status === 'failed' || previous?.status === 'partial') {
          if (previous.blocked || (Number(previous.attempts || 1) >= MAX_ATTEMPTS && !previous.nextRetryAt)) {
            return { ok: false, blocked: true, added: 0, insights: 0, message: `提炼批次 ${batch.id} 已达重试上限，请人工处理` }
          }
          const retryAfter = nextRetryAt(previous)
          if (Date.now() < retryAfter) return { ok: false, retryAfter, added: 0, insights: 0, message: `提炼批次 ${batch.id} 将在冷却后重试` }
        }
        if (previous?.status === 'running' || previous?.status === 'pending') throw new Error(`提炼批次 ${batch.id} 已完成事实提交但状态未确认，请核对后恢复`)
        const scope = scopeOf(chatId)
        batchState.start(batch, scope)
        let count = 0
        try {
          count = await extractFacts(chatId, part.map(formatLine).join('\n'), genSignal)
          if (!isActive()) throw new Error('记忆模块已关闭')
          if (genSignal && !genSignal.isValid()) throw new Error('提炼任务已取消')
        } catch (error) {
          batchState.fail(batch, scope, error)
          throw error
        }
        batchState.done(batch, scope, count)
        added += count
      }
      if (genSignal && !genSignal.isValid()) throw new Error('提炼任务已取消')
      log?.info?.(`从 ${chatId} 的${isQzone ? '空间动态' : '聊天'}里提炼了 ${added} 条新记忆`)
      if (isQzone) return { ok: true, added, insights: 0 }
      const [kind, id] = chatId.split(':')
      const chat = kind === 'group' ? { kind, groupId: id, nickname: '' } : { kind: 'private', userId: id, nickname: talk.filter((line) => line.who !== 'bot').at(-1)?.who || '' }
      const insights = await reflect(chat, talk.slice(-120).map((line) => `${line.who === 'bot' ? '我' : line.who}：${line.text}`).join('\n'), genSignal)
      return { ok: true, added, insights }
    } catch (error) {
      log?.warn?.('提炼记忆失败：', error.message)
      return { ok: false, message: error.message, added, insights: 0 }
    }
  }

  async function consolidate(o = {}) {
    if (!isActive()) return { ok: false, message: '记忆模块已关闭' }
    const health = consolidation.health()
    if (!health.ok) return { ok: false, message: '记忆档案或运行状态异常，请修复后重载档案', health }
    if (consolidationBusy) return { ok: false, message: '正在整理中' }
    consolidationBusy = true
    const genSignal = consolidation.createGenerationSignal(120000)
    const today = dayKey()
    const startedAt = Date.now()
    let added = 0
    let insights = 0
    let days = 0
    let profiles = 0
    const failedChats = []
    try {
      for (const day of consolidation.chatLogDays()) {
        if (!genSignal.isValid()) break
        if (day > today || (day === today && !o.includeToday)) continue
        const snapshot = consolidation.chatLogSnapshot(day)
        const all = snapshot.records
        const progress = consolidation.load()
        const done = (progress.processed || {})[day] || 0
        const previousSource = progress.processedSources?.[day]
        if (done > all.length) throw new Error(`${day} 的共享流水已缩短，请核对消费进度`)
        if (previousSource && previousSource.count !== done) throw new Error(`${day} 的共享流水消费进度不一致，请核对后恢复`)
        const offset = chatLogOffset(snapshot, previousSource)
        if (previousSource && done === all.length) continue
        const byChat = new Map()
        for (const line of all.slice(offset)) {
          if (!line || !line.chatId || String(line.chatId).startsWith('system:')) continue
          if (/^【更早聊天的摘要/.test(String(line.text || ''))) continue
          if (!byChat.has(line.chatId)) byChat.set(line.chatId, [])
          byChat.get(line.chatId).push(line)
        }
        const failuresBefore = failedChats.length
        for (const [chatId, lines] of byChat) {
          if (!genSignal.isValid()) break
          try {
            const result = await extractLines(chatId, lines, genSignal)
            if (result.blocked || result.retryAfter) {
              failedChats.push({ day, chatId, error: result.message, ...(result.blocked ? { blocked: true } : { retryAfter: result.retryAfter }) })
              continue
            }
            added += result.added || 0
            insights += result.insights ? 1 : 0
            if (!result.ok) throw new Error(result.message || '记忆提炼失败')
          } catch (error) {
            failedChats.push({ day, chatId, error: error.message })
            log?.warn?.(`提炼 ${day} 聊天 ${chatId} 记忆失败:`, error.message)
          }
        }
        if (genSignal.isValid() && failedChats.length === failuresBefore) {
          const cursor = chatLogCursor(snapshot)
          chatLogOffset(consolidation.chatLogSnapshot(day), cursor)
          const state = consolidation.load()
          state.processed = state.processed || {}
          state.processed[day] = all.length
          state.processedSources = state.processedSources || {}
          state.processedSources[day] = cursor
          consolidation.save(state)
          days++
        }
      }
      if (days && genSignal.isValid()) await consolidation.learnSelfStyle(genSignal)
      const live = consolidation.load()
      const touched = [...new Set(live.items
        .filter((item) => item.about && (item.at >= startedAt || (item.invalidAt || 0) >= startedAt))
        .map((item) => consolidation.profileKeyOf(item.about, String(item.scope || 'global'))))]
      const count = new Map()
      for (const item of live.items) {
        if (!item.about || item.invalidAt) continue
        const key = consolidation.profileKeyOf(item.about, String(item.scope || 'global'))
        count.set(key, (count.get(key) || 0) + 1)
      }
      const missing = [...count]
        .filter(([key, n]) => n >= 3 && !(live.profiles || {})[key] && !touched.some((item) => item === key))
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => key)
      const targets = [...new Set([...touched, ...missing])].slice(0, 8)
      for (const key of targets) {
        if (!genSignal.isValid()) break
        const at = key.lastIndexOf('@')
        const qq = at > 0 ? key.slice(0, at) : key
        const scope = at > 0 ? key.slice(at + 1) : 'global'
        try { if (await consolidation.buildProfile(qq, scope, genSignal)) profiles++ } catch (error) { log?.warn?.('写人物小档案失败：', error.message) }
      }
      if (!genSignal.isValid()) return { ok: false, message: '整理任务已中止或已关闭', failed: failedChats }
      const state = consolidation.load()
      const now = Date.now()
      let blurred = 0
      for (const item of state.items) {
        if (item.invalidAt || item.pinned) continue
        if (item.source !== 'event' && item.source !== 'auto') continue
        const step = clarityOf({ ...item, ownerQQ: getConfig()?.ownerQQ || '' }, now)
        if (item.clarity !== step) {
          item.clarity = step
          blurred++
        }
      }
      const before = state.items.length
      state.items = state.items.filter((item) => !shouldForget({ ...item, ownerQQ: getConfig()?.ownerQQ || '' }))
      const forgot = before - state.items.length
      if (forgot || blurred) state.rev = (state.rev || 0) + 1
      state.lastConsolidate = { day: today, at: Date.now(), added, insights, days, forgot, blurred, profiles, failed: failedChats }
      consolidation.save(state)
      const message = `${failedChats.length ? `部分整理失败（${failedChats.length} 个聊天），失败日期进度未推进` : '整理好了'}：新增或更新 ${added} 条记忆，更新 ${insights} 份相处经验、${profiles} 份人物小档案${blurred ? `，${blurred} 条变模糊` : ''}${forgot ? `，忘掉 ${forgot} 条旧的` : ''}`
      log?.info?.(message)
      return { ok: failedChats.length === 0, added, insights, days, forgot, blurred, profiles, failed: failedChats, message }
    } catch (error) {
      log?.warn?.('整理临时记忆失败：', error.message)
      return { ok: false, message: error.message, failed: failedChats }
    } finally {
      genSignal.cleanup()
      consolidationBusy = false
    }
  }

  return { extractFacts, extractLines, consolidate }
}
