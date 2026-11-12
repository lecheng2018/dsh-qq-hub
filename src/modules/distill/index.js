// 蒸馏群友流水线模块（独立 optional 模块，按模块化重构结构落地）：
//   L0 计数（activity 事件）→ L1 原子特征批（每 ~10 条，每小时限流）→
//   L2 场景聚合（累计 5 批）→ L3 人格增长段（每日一次）→ 派生人设卡增长区段。
//
// 结构（对照任务书红线逐条）：
//   - 纯逻辑在 src/features/distill-pipeline.js（提示词/解析器/行为统计，独立可测）；
//   - 本模块只做接线与状态：**状态存模块命名空间**（api.dataDir → modules-data/distill/），
//     不写进 memory.json——共享状态有唯一 owner（本模块）；
//   - 目标与历史画像归本模块 store.json；memory.distillList 仅在首次启动时只读迁移；
//     历史学习、注入、路由和派生卡刷新均由本模块负责，memory 不再承担业务写入；
//   - 模型可配小成本：memory.distillModel（留空跟随主模型）；批阈值 memory.distillBatch。
//
// 边界（写进产物也写进提示词）：只借说话方式与行为节奏，不冒充对方；
// 底卡正文与安全规则不可被蒸馏修改；数据全程本地。

import { readJson, writeJson } from '../../core/store.js'
import { askModel, withAbortTimeout, modelWithOverride } from '../../core/llm.js'
import { readChatLogSource, chatLogCursor, chatLogOffset } from '../../chat/chat-log.js'
import { collectMemberLines, enoughEvidence, dedupConvo, renderDistillHint } from '../../features/distill.js'
import { createDistillStore } from '../../features/distill-store.js'
import { createMemoryDistillHistory } from '../../features/memory-distill-history.js'
import { refreshDistillCard, styleEntries } from '../../persona/distill-card.js'
import {
  behaviorStats, renderBehaviorDigest, buildL1Prompt, parseL1, buildL2Prompt, parseL2,
  buildL3Prompt, parseL3, shouldTriggerL1, shouldTriggerL2, renderGrowthSegment,
} from '../../features/distill-pipeline.js'

const EMPTY = Object.freeze({ newCount: 0, batches: [], batchesSinceL2: 0, samples: [] })

/**
 * 蒸馏引擎工厂（依赖注入，测试用假件全测）。
 * @param {object} o
 * @param {() => object} o.config 全局配置读取
 * @param {() => Array<{gid:string, uid:string, name?:string}>} o.targetsOf 蒸馏目标列表（memory 模块公开面）
 * @param {() => object} o.loadState / o.saveState(state) 模块命名空间持久化
 * @param {{ listDays: () => string[], readDay: (day: string) => object[] }} o.chatLog 群聊流水只读服务
 * @param {(dsh: object, opts: object) => Promise<string>} [o.askModelImpl] 模型调用（测试注入）
 * @param {object} [o.dsh] DSH 上下文（askModel 需要）
 */
export function createDistillEngine({
  config, targetsOf, loadState, saveState, chatLog, chatLogDays, chatLogOf,
  askModelImpl = askModel, dsh = null, log = console, now = Date.now,
}) {
  let state = loadState() || {}
  const lifetime = new AbortController()
  const pendingL1 = new Set()
  const runningL1 = new Map()
  const retryL1After = new Map()
  const sourceLog = chatLog || { listDays: () => chatLogDays?.() || [], readDay: (day) => chatLogOf?.(day) || [] }

  const pipeOf = (key) => state[key] || EMPTY
  function putPipe(key, patch) {
    lifetime.signal.throwIfAborted()
    const next = { ...state, [key]: { ...EMPTY, ...(state[key] || {}), ...patch } }
    saveState(next)
    state = next
    return state[key]
  }

  const distillCfg = () => {
    const cfg = config() || {}
    return {
      enabled: !lifetime.signal.aborted && cfg.enabled !== false && cfg.memory?.distill !== false && cfg.memory?.distillPipeline !== false,
      threshold: Math.max(5, Number(cfg.memory?.distillBatch) || 10),
      model: cfg.memory?.distillModel || { provider: '', model: '' },
      timeoutMs: Math.max(1, Number(cfg.memory?.distillTimeoutMs) || 120_000),
      retryMs: Math.max(0, Number(cfg.memory?.distillRetryMs ?? 300_000) || 0),
    }
  }

/** 各层 token 预算。蒸馏是「结构化 JSON 输出」，思考型模型（MiniMax-M3.1-Flash
 *  这类 forceAdaptiveThinking，思考关不掉）会先吃掉一大段预算写分析，正文 JSON
 *  才轮到。1.3.66 实测 L1 用 1200：7 次尝试 7 次解析失败，回包开头全是
 *  「## 用户画像 · xxx」「# 用户画像：xxx」这种 Markdown 报告，JSON 一个字没有。
 *  一键「从历史学」同样模型用 8000 就 3 次全成 —— 差别就在预算。 */
  const DISTILL_TOKENS = { l1: 4000, l2: 4000, l3: 4000 }

  /** 蒸馏用模型：distillModel 两个字段都填了才替换，否则跟随主模型。
 *  合并规则在 core/llm.js 的 modelWithOverride（空串覆盖主模型是个坑，见那里注释）。 */
  async function askDistillModel(prompt, maxTokens = DISTILL_TOKENS.l1) {
    const cfg = config() || {}
    const dc = distillCfg()
    const merged = { ...cfg, model: modelWithOverride(cfg.model, dc.model) }
    return withAbortTimeout(
      (signal) => askModelImpl(dsh, {
        cfg: merged, ...prompt, maxTokens, temperature: 0.3,
        // 这里**故意不指定 reasoningEffort**，交给 askModel 的默认档（low）。
        // 不要写 'off'：MiniMax-M3.1-Flash 属于 forceAdaptiveThinking 模型，服务端
        // 不接受 thinking.type=disabled（实测 400）；宿主侧 pickReasoningEffort 也会把
        // 不支持的档收敛回默认档，等于没写。真正解决「回包写成报告」的是上面的 token
        // 预算 + JSON_NUDGE 当场纠正。
        signal,
      }),
      dc.timeoutMs,
      '蒸馏请求',
      lifetime.signal,
    )
  }

  /** 回包不是约定 JSON 时的当场纠正提示：比整批丢掉、等攒够下一批再重跑省得多。 */
  const JSON_NUDGE = '\n\n（上一轮回包不是约定格式。重新只输出 JSON 对象本身：以 { 开头、} 结尾，不要标题、前言、解释或 Markdown 列表。）'

  /** 问一次并解析；解析失败当场带纠正提示重试一次。
   * 返回 {rec}=成功 / {out}=两次都解析失败 / {error}=模型调用失败；日志措辞由调用方保持原样。 */
  async function askJson(parse, prompt, maxTokens) {
    let out = ''
    try {
      out = await askDistillModel(prompt, maxTokens)
    } catch (error) {
      return { error }
    }
    let rec = parse(out)
    if (rec) return { rec }
    try {
      out = await askDistillModel({ ...prompt, text: (prompt.text || '') + JSON_NUDGE }, maxTokens)
    } catch (error) {
      return { error }
    }
    rec = parse(out)
    return rec ? { rec } : { out }
  }

  function scheduleL1(target) {
    const dc = distillCfg()
    const key = `${target.gid}#${target.uid}`
    const p = pipeOf(key)
    if (!dc.enabled || pendingL1.has(key) || now() < Number(retryL1After.get(key) || 0)) return
    if (!shouldTriggerL1(p, { threshold: dc.threshold, now: now() }) && !shouldTriggerL2(p, { batches: 5 })) return
    const consumedCount = Number(p.newCount || 0)
    pendingL1.add(key)
    return Promise.resolve()
      .then(() => runL1(target.gid, target.uid, target))
      .then((processed) => {
        if (!distillCfg().enabled) return
        if (!processed) {
          retryL1After.set(key, now() + dc.retryMs)
          return
        }
        putPipe(key, { newCount: Math.max(0, Number(pipeOf(key).newCount || 0) - consumedCount) })
        retryL1After.delete(key)
      })
      .catch((error) => {
        retryL1After.set(key, now() + dc.retryMs)
        log.warn?.(`蒸馏L1（${target.name || target.uid}）失败：`, error.message)
      })
      .finally(() => pendingL1.delete(key))
  }

  function noteMessage(chatId, uid, t = now()) {
    if (!distillCfg().enabled || !String(chatId || '').startsWith('group:')) return
    const gid = String(chatId).slice(6)
    const u = String(uid || '')
    const target = targetsOf().find((x) => String(x.gid) === gid && String(x.uid) === u)
    if (!target) return
    const key = `${gid}#${u}`
    const p = pipeOf(key)
    putPipe(key, { newCount: (p.newCount || 0) + 1, samples: [...(p.samples || []), Number(t) || now()].slice(-400) })
    return scheduleL1(target)
  }

  function runL1(gid, uid, target) {
    const key = `${gid}#${uid}`
    if (runningL1.has(key)) return runningL1.get(key)
    const task = consumeL1(gid, uid, target)
      .catch((error) => { log.warn?.(`蒸馏L1（${target?.name || uid}）失败：`, error.message); return false })
      .finally(() => runningL1.delete(key))
    runningL1.set(key, task)
    return task
  }

  async function consumeL1(gid, uid, target) {
    if (!distillCfg().enabled) return false
    const key = `${gid}#${uid}`
    if (shouldTriggerL2(pipeOf(key), { batches: 5 }) && !await runL2(gid, uid, target)) return false
    for (const day of sourceLog.listDays().slice().sort()) {
      const snapshot = readChatLogSource(sourceLog, day)
      const records = snapshot.records
      let offset = chatLogOffset(snapshot, pipeOf(key).sources?.[day])
      while (offset < records.length) {
        if (!distillCfg().enabled) return false
        let end = offset
        let count = 0
        while (end < records.length) {
          const row = records[end++]
          if (row.chatId === `group:${gid}` && String(row.uid || '') === String(uid)) count++
          if (count >= 14) break
        }
        const lines = records.slice(offset, end).filter((l) => l.chatId === `group:${gid}`)
        const mine = collectMemberLines(lines, uid)
        const cursor = chatLogCursor(snapshot, end)
        let patch = {}
        if (enoughEvidence(mine, { minMessages: 5, minChars: 40 })) {
          const batchId = `b-${day}-${cursor.fingerprint.slice(0, 16)}`
          const stats = behaviorStats(lines, uid)
          const context = dedupConvo(lines.map((l) => ({ uid: l.uid, name: l.name || l.who || l.uid || '', text: String(l.text || '') }))).slice(-40)
          const prompt = buildL1Prompt({ uid, batchId, messages: mine.map((x) => x.text), context, behaviorDigest: renderBehaviorDigest(stats) })
          const { rec, out, error } = await askJson((raw) => parseL1(raw, { uid, batchId }), prompt)
          // 失败就**不推进 cursor**：这一窗口的证据留在原地，下次触发重读同一批。
          // 1.3.66 之前的写法是无论成败都写 cursor，L1 又 7 次全败 —— 那 7 批原话
          // 被永久跳过（samples 只存时间戳，原文无从重建）。throw 让上层进重试冷却。
          if (error) throw error
          if (!rec) throw new Error(`回包解析失败: ${String(out).slice(0, 120)}`)
          if (!distillCfg().enabled) return false
          const p = pipeOf(key)
          patch = { batches: [...(p.batches || []), { ...rec, batch_id: batchId }].slice(-8), batchesSinceL2: (p.batchesSinceL2 || 0) + 1, lastL1At: now(), behavior: stats }
        }
        // 只有「这一窗口处理成功」或「证据本来就不够（跳过是正确结果）」才推进 cursor
        chatLogOffset(readChatLogSource(sourceLog, day), cursor)
        putPipe(key, { ...patch, sources: { ...pipeOf(key).sources, [day]: cursor } })
        offset = end
        if (shouldTriggerL2(pipeOf(key), { batches: 5 }) && !await runL2(gid, uid, target)) return false
      }
    }
    return true
  }

  async function runL2(gid, uid, target) {
    if (!distillCfg().enabled) return false
    const key = `${gid}#${uid}`
    const p = pipeOf(key)
    if (!(p.batches || []).length) return true
    const prompt = buildL2Prompt({ uid, l1List: p.batches, behaviorDigest: renderBehaviorDigest(p.behavior) })
    const { rec, out, error } = await askJson((raw) => parseL2(raw, { uid }), prompt, DISTILL_TOKENS.l2)
    if (error || !rec) {
      log.warn?.(`蒸馏L2（${target?.name || uid}）失败：`, error?.message || String(out).slice(0, 120))
      return false
    }
    if (!distillCfg().enabled) return false
    putPipe(key, { l2: rec, batchesSinceL2: Math.max(0, Number(pipeOf(key).batchesSinceL2 || 0) - Number(p.batchesSinceL2 || 0)) })
    return true
  }

  let runningL3 = null
  function runL3Daily(opts = {}) {
    if (runningL3) return runningL3
    runningL3 = consumeL3(opts).finally(() => { runningL3 = null })
    return runningL3
  }

  async function consumeL3({ onGrowth, day } = {}) {
    if (!distillCfg().enabled) return 0
    let updated = 0
    for (const t of targetsOf()) {
      if (!distillCfg().enabled) break
      const key = `${t.gid}#${t.uid}`
      const p = pipeOf(key)
      if (!p.l2 || (day && p.lastL3Day === day)) continue
      const prompt = buildL3Prompt({ uid: t.uid, oldSegment: p.l3?.persona_segment || null, sceneTemplates: p.l2.scene_templates, behaviorDigest: renderBehaviorDigest(p.behavior) })
      try {
        const { rec: seg, out, error } = await askJson((raw) => parseL3(raw, { uid: t.uid }), prompt, DISTILL_TOKENS.l3)
        if (error) throw error
        if (!seg) throw new Error(`回包解析失败: ${String(out).slice(0, 120)}`)
        if (!distillCfg().enabled) break
        putPipe(key, { l3: seg })
        if (onGrowth) await onGrowth(String(t.gid), t)
        if (day && distillCfg().enabled) putPipe(key, { lastL3Day: day })
        updated++
      } catch (error) { log.warn?.(`蒸馏L3（${t.name || t.uid}）失败：`, error.message) }
    }
    return updated
  }

  async function dailyTick({ onGrowth } = {}) {
    if (!distillCfg().enabled) return
    await Promise.all(targetsOf().map(scheduleL1))
    if (!distillCfg().enabled || new Date(now()).getHours() < 4) return
    return runL3Daily({ onGrowth, day: new Date(now()).toDateString() })
  }

  function dispose() {
    lifetime.abort(new Error('蒸馏模块已关闭'))
  }

  /** 面板/诊断：各目标流水线状态。 */
  function status() {
    return targetsOf().map((t) => {
      const p = pipeOf(`${t.gid}#${t.uid}`)
      return {
        gid: t.gid, uid: t.uid, name: t.name,
        newCount: p.newCount || 0,
        batches: (p.batches || []).length,
        hasSceneTemplates: Boolean(p.l2),
        hasGrowthSegment: Boolean(p.l3),
        lastL1At: p.lastL1At || 0,
      }
    })
  }

  /** 某群各目标的 L3 增长段（派生卡渲染用）。 */
  function growthList(gid) {
    return targetsOf()
      .filter((t) => String(t.gid) === String(gid))
      .map((t) => ({ uid: t.uid, name: t.name, segment: pipeOf(`${t.gid}#${t.uid}`).l3 }))
      .filter((x) => x.segment)
  }

  return { noteMessage, runL1, runL2, runL3Daily, dailyTick, status, growthList, renderGrowthSegment, dispose }
}

// 模块装载时的蒸馏目标读取：走 memory 模块公开面（api.use('memory')），不 import 它的内部文件。
export const distillModule = {
  id: 'distill',
  name: '蒸馏群友',
  version: '1.0.0',
  api: 1,
  description: '分层蒸馏流水线：把指定群友的说话方式与行为节奏蒸馏成人格增长段（L1 增量批 → L2 场景聚合 → L3 每日沉淀），写进群的派生人设卡。只借说话方式，不冒充对方。',
  provides: ['persona-growth'],
  requires: ['memory-store'],
  tab: 'mood',
  files: ['features/distill-pipeline.js', 'features/distill.js', 'features/distill-store.js', 'features/memory-distill-history.js'],
  setup(api) {
    const stateFile = api.dataDir('pipeline.json')
    let legacy = []
    try { legacy = api.use('memory')?.distillList?.() || [] } catch {}
    const store = createDistillStore({ file: api.dataDir('store.json'), legacy })
    const engine = createDistillEngine({
      config: api.config,
      targetsOf: () => store.targets(),
      loadState: () => readJson(stateFile),
      saveState: (s) => writeJson(stateFile, s),
      chatLog: api.core.chatLog,
      askModelImpl: askModel,
      dsh: api.dsh,
      log: api.log,
    })
    const refreshCard = (gid) => {
      const entries = styleEntries(store.list().filter((target) => String(target.gid) === String(gid)))
      const growth = engine.growthList(String(gid)) || []
      const r = refreshDistillCard({ gid, entries, growth, cfg: api.config(), log: api.log })
      if (r.ok) api.setConfig({ persona: { groups: { [String(gid)]: r.cardId } } })
      return r
    }
    let active = true
    let generation = 1
    const controllers = new Set()
    function createGenerationSignal(timeoutMs = 120000) {
      const controller = new AbortController()
      const current = generation
      controllers.add(controller)
      const timer = setTimeout(() => controller.abort(new Error('历史蒸馏超时')), timeoutMs)
      timer.unref?.()
      return {
        signal: controller.signal,
        isValid: () => active && generation === current && !controller.signal.aborted,
        cleanup: () => { clearTimeout(timer); controllers.delete(controller) },
      }
    }
    function generationOf(external) {
      const owned = external ? null : createGenerationSignal()
      return { signal: external || owned, cleanup: () => owned?.cleanup() }
    }
    const history = createMemoryDistillHistory({
      dsh: api.dsh,
      getConfig: api.config,
      hub: api.core.hub,
      chatLog: api.core.chatLog,
      log: api.log,
      onDistillLearned: refreshCard,
      distillOf: store.of,
      putDistill: store.put,
      createGenerationSignal,
      generationOf,
      isActive: () => active,
    })

    api.context(({ chat }) => {
      if (chat.kind !== 'group') return ''
      const hints = []
      for (const target of store.targets()) {
        if (String(target.gid) !== String(chat.groupId)) continue
        const hint = renderDistillHint(target.name || target.uid, store.of(target.gid, target.uid) || {})
        if (hint) hints.push(hint)
      }
      return hints.join('\n')
    })
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'in') return
        if (a.chatId && a.userId) engine.noteMessage(a.chatId, a.userId)
      } catch (error) { api.log.debug?.('蒸馏消息计数失败：', error.message) }
    })
    api.on('distill/growth-updated', (payload) => {
      const gid = String(payload?.gid || '')
      if (gid) refreshCard(gid)
    })
    api.every(60_000, () => engine.dailyTick({
      onGrowth: async (gid) => { api.emit('distill/growth-updated', { gid }) },
    }), '蒸馏每日沉淀')

    const { http } = api.core
    api.route('/distill/list', async () => ({ ok: true, list: store.list() }))
    api.route('/distill/add', async (req) => store.addTarget(await http.body(req)))
    api.route('/distill/remove', async (req) => {
      const body = await http.body(req)
      return store.removeTarget(body.gid, body.uid)
    })
    api.route('/distill/history', async (req) => {
      const query = http.query(req) || {}
      const result = history.history({ gid: query.group || '' })
      return {
        ok: true, dir: result.dir, sessions: result.sessions, total: result.total,
        chatlogDays: result.chatlogDays || 0, chatlogLines: result.chatlogLines || 0,
        from: result.from, to: result.to, speakers: result.speakers,
      }
    })
    api.route('/distill/from-history', async (req) => history.learnFromHistory(await http.body(req)))
    api.route('/distill/card/refresh', async (req) => {
      const body = await http.body(req)
      if (!body.gid) return { ok: false, message: '没给群号' }
      return refreshCard(body.gid)
    })
    api.route('/distill/pipeline/status', async () => ({ ok: true, status: engine.status() }))
    api.route('/distill/pipeline/run-l3', async () => {
      const n = await engine.runL3Daily({
        onGrowth: async (gid) => { api.emit('distill/growth-updated', { gid }) },
      })
      return { ok: true, updated: n }
    })

    return {
      status: () => engine.status(),
      growthList: (gid) => engine.growthList(gid),
      runL3Daily: (opts) => engine.runL3Daily(opts),
      history: (options) => history.history(options),
      learnFromHistory: (options) => history.learnFromHistory(options),
      dispose: () => {
        active = false
        generation++
        for (const controller of controllers) {
          try { controller.abort(new Error('distill disposed')) } catch {}
        }
        controllers.clear()
        engine.dispose()
      },
    }
  },
}

export default distillModule
