import { createHash } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { collectMemberLines, enoughEvidence, evidenceFunnel, describeFunnel, buildDistillPrompt, parseDistillProfile, dedupConvo, safeParseJson, recognizedFields } from './distill.js'
import { sessionsDirFor, scanTranscripts, speakerCounts } from './session-history.js'
import { workspaceDirOf } from '../chat/workspace.js'
import { readChatLogSource } from '../chat/chat-log.js'

export function createMemoryDistillHistory({
  dsh, getConfig, hub, chatLog = hub, log, onDistillLearned,
  distillOf, putDistill, createGenerationSignal, generationOf, isActive,
}) {
  const sourceLog = chatLog?.listDays ? chatLog : { listDays: () => hub?.chatLogDays?.() || [], readDay: (day) => hub?.chatLogOf?.(day) || [] }
  const chatLogDays = () => sourceLog.listDays()
  const chatLogSnapshot = (day) => readChatLogSource(sourceLog, day)

  // ---------------- 从会话历史蒸馏（1.3.63）----------------
  // chatlog 按保留天数滚动清理；会话记录留得更久。但**会话记录会脱敏主人**：
  // 群聊上下文里主人发言被渲染成「主人：…」（不带 QQ 号，见 chat/hub.js 的 whoOf），
  // 而解析正则要求「名字(数字)：」——所以主人自己的发言永远捞不到，句数卡死不变。
  // chatlog 存的是真实 uid，不受这层脱敏影响，且能精确按群 id 过滤。

  /**
   * 扫一遍历史，给出「谁说了多少句」和覆盖的时间范围（面板用）。
   * 证据源优先 chatlog（真实 uid + 可精确按群 id 过滤），会话记录只作补充。
   */
  function history ({ gid = '' } = {}) {
    const cfg = getConfig()
    const dir = sessionsDirFor(workspaceDirOf(cfg), { dshHome: process.env.DSH_HOME || '' })
    const group = String(gid || '').replace(/\D/g, '')
    // 群名只用于会话记录那边的粗过滤（它按【群聊 xxx】头匹配）
    let groupName = ''
    if (group && hub?.groupNames?.get) { try { groupName = hub.groupNames.get(group) || '' } catch {} }
    const scan = scanTranscripts(dir, { group: groupName })

    // chatlog：真实 uid，能按 chatId 精确过滤
    const logLines = []
    let logDays = []
    try {
      logDays = chatLogDays().slice().sort()
      for (const day of logDays) {
        // chatLogSnapshot 给的是 { day, records, ... } 快照对象，不是数组
        for (const r of (chatLogSnapshot(day)?.records || [])) {
          if (!r || !r.text) continue
          if (group && String(r.chatId) !== `group:${group}`) continue
          logLines.push({
            name: String(r.who || r.uid || ''),
            uid: String(r.uid || ''),
            text: String(r.text || ''),
            at: Number(r.t) || 0,
          })
        }
      }
    } catch (error) {
      log?.warn?.('蒸馏：读 chatlog 失败，退回会话记录：', error.message)
    }

    // 合并：chatlog 优先（有真实 uid），会话记录补更早的历史
    const merged = [...logLines]
    const seenKey = new Set(logLines.map((l) => `${l.uid}|${String(l.text).trim().slice(0, 80)}`))
    for (const l of scan.lines) {
      const k = `${l.uid}|${String(l.text).trim().slice(0, 80)}`
      if (seenKey.has(k)) continue
      seenKey.add(k)
      merged.push({ name: l.name, uid: l.uid, text: l.text, at: Number(l.at) || 0 })
    }

    let from = 0
    let to = 0
    for (const l of merged) {
      if (!l.at) continue
      if (!from || l.at < from) from = l.at
      if (l.at > to) to = l.at
    }
    return {
      dir,
      sessions: scan.sessions,
      chatlogDays: logDays.length,
      chatlogLines: logLines.length,
      total: merged.length,
      from,
      to,
      speakers: speakerCounts(merged, 20),
      lines: merged,
    }
  }

  /**
   * 从历史里给某个目标学一次（立即出画像，不用等）。
   * @returns {{ok:boolean, message:string, learned?:object}}
   */
  async function learnFromHistory ({ gid, uid, name = '', minMessages } = {}) {
    const task = generationOf(null)
    const genSignal = task.signal
    try {
      const cfg = getConfig()
    if (cfg.memory?.distill === false) return { ok: false, message: '蒸馏群友开关关着' }
    const g = String(gid || '').replace(/\D/g, '')
    const u = String(uid || '').replace(/\D/g, '')
    if (!g || !u) return { ok: false, message: '群号和 QQ 号都要填' }
    // 按群 id 精确过滤（chatlog 有 chatId；会话记录那边靠群名粗过滤兜底）
    const hist = history({ gid: g })
    if (!hist.total) {
      const where = hist.chatlogDays ? `${hist.chatlogDays} 天聊天流水 + ` : ''
      return { ok: false, message: `没找到历史记录（翻了 ${where}${hist.sessions} 个会话）` }
    }
    // 历史学习先清洗（去重 + 滤纯转发），清洗后质量高，门槛相应降到 15 句
    const mine = collectMemberLines(hist.lines.map((l) => ({ ...l, t: l.at })), u)
    const t0name = name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u
    const minMsg = Number(minMessages) || 15
    if (!enoughEvidence(mine, { minMessages: minMsg })) {
      const funnel = evidenceFunnel(hist.lines, u)
      return {
        ok: false,
        message: `历史里他的原话只有 ${mine.length} 句（去重滤转发后），不够 ${minMsg} 句，学出来也是瞎猜——等多聊几天再来${describeFunnel(funnel)}`,
        funnel,
      }
    }
    const others = hist.lines.filter((l) => String(l.uid) !== u && !/^\[分享卡片|^https?:/.test(String(l.text))).slice(-60).map((l) => `${l.name}：${String(l.text).slice(0, 100)}`)
    const old = distillOf(g, u)
    const { system, text } = buildDistillPrompt({
      name: name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u,
      uid: u,
      memberLines: mine,
      context: dedupConvo(hist.lines).slice(-80),
      others,
      old,
    })
    let out = ''
    try {
      // 12000：五段 JSON 本身就长，思考型模型还要先花掉一大截在思考段上。
      // 实测 8000 时回包被截断（数组写到一半就断），JSON 解析直接失败 —— 这是
      // 「模型判空」的另一条暗线，和键名漂移叠加在一起。
      // reasoningEffort 不钉死 'none'：自适应思考类模型 disabled 会 400，
      // 交给 askModel 的 pickReasoningEffort 按模型能力挑。
      out = await askModel(dsh, { cfg, system, text, maxTokens: 12000, temperature: 0.3, signal: genSignal.signal })
    } catch (error) {
      return { ok: false, message: '提炼失败：' + error.message }
    }
    const profile = parseDistillProfile(out)
    if (!profile) {
      log.warn(`蒸馏群友（历史）：${t0name} 回包解析失败，原始前 200 字：`, String(out).slice(0, 200))
      return { ok: false, message: '模型回包没解析成 JSON（原因已记日志，可再点一次重试）' }
    }
    const hasProfile = Boolean(profile.exchanges?.length || profile.syntax?.length || profile.catchphrases?.length || profile.rhetoric?.length || profile.persona?.length || profile.samples?.length || profile.style?.length)
    if (!hasProfile) {
      // 判空有三种完全不同的原因，别一律说「证据不足」糊弄用户：
      //   a) 模型没按约定键名回包（实测会写「句子架构」「口头禅」甚至自创 learned_style）
      //   b) 回包被截断（maxTokens 不够，JSON 只写了一半）
      //   c) 模型认真看完后认为没有可提炼的稳定特征
      const fields = recognizedFields(safeParseJson(out))
      const fieldText = Object.keys(fields).length ? Object.entries(fields).map(([k, n]) => `${k}×${n}`).join('、') : '无'
      const rawLen = String(out || '').length
      const looksTruncated = !/}\s*$/.test(String(out || '').trim())
      log.info(`蒸馏群友（历史）：${t0name} 画像判空（识别到字段：${fieldText}；回包 ${rawLen} 字${looksTruncated ? '，结尾不完整疑似截断' : ''}），原始前 400 字：`, String(out).slice(0, 400))
      if (!Object.keys(fields).length && looksTruncated) {
        return { ok: false, message: `模型回包被截断了（写了 ${rawLen} 字还没收尾），没法学。可以再点一次重试，或把蒸馏用模型换成上下文更大的模型` }
      }
      if (!Object.keys(fields).length) {
        return { ok: false, message: '模型没按约定的字段名回包（认不出 exchanges/syntax 等任何一个），所以没法入库。原文已记日志，可再点一次重试' }
      }
      return { ok: false, message: '模型看完认为他的原话里没有稳定可学的说话特征，暂时不学（不是句数不够，句数已经够了）' }
    }
      if (!isActive() || !genSignal.isValid()) return { ok: false, message: '历史学习任务已取消' }
      const sourceFingerprint = createHash('sha256').update(JSON.stringify(mine)).digest('hex')
      const saved = putDistill(g, u, profile, mine.length, { sourceFingerprint })
      log.info(`蒸馏群友（历史）：学到 ${name || u} 的说话样子（${mine.length} 句原话）`)
      try { onDistillLearned && await onDistillLearned(g) } catch (error) { log.warn('刷新语感人设卡出错：', error.message) }
      return { ok: true, message: `从历史里学到了（${mine.length} 句）`, learned: saved }
    } finally {
      task.cleanup()
    }
  }


  return { history, learnFromHistory }
}
