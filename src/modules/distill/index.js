// 蒸馏群友流水线模块（独立 optional 模块，按模块化重构结构落地）：
//   L0 计数（activity 事件）→ L1 原子特征批（每 ~10 条，每小时限流）→
//   L2 场景聚合（累计 5 批）→ L3 人格增长段（每日一次）→ 派生人设卡增长区段。
//
// 结构（对照任务书红线逐条）：
//   - 纯逻辑在 src/features/distill-pipeline.js（提示词/解析器/行为统计，独立可测）；
//   - 本模块只做接线与状态：**状态存模块命名空间**（api.dataDir → modules-data/distill/），
//     不写进 memory.json——共享状态有唯一 owner（本模块）；
//   - 依赖走公开面：目标列表经 api.use('memory').distillList()（memory 模块声明
//     provides: ['memory-store']，本模块 requires 它——SDK 装载计划强制顺序）；
//     学成后 emit('distill/growth-updated', { gid })，memory 模块监听并刷新派生卡；
//   - 模型可配小成本：memory.distillModel（留空跟随主模型）；批阈值 memory.distillBatch。
//
// 边界（写进产物也写进提示词）：只借说话方式与行为节奏，不冒充对方；
// 底卡正文与安全规则不可被蒸馏修改；数据全程本地。

import { readJson, writeJson } from '../../core/store.js'
import { askModel, withAbortTimeout } from '../../core/llm.js'
import { collectMemberLines, enoughEvidence, dedupConvo } from '../../features/distill.js'
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
 * @param {() => string[]} o.chatLogDays / o.chatLogOf(day) 群聊流水（hub 公开面）
 * @param {(dsh: object, opts: object) => Promise<string>} [o.askModelImpl] 模型调用（测试注入）
 * @param {object} [o.dsh] DSH 上下文（askModel 需要）
 */
export function createDistillEngine({
  config, targetsOf, loadState, saveState, chatLogDays, chatLogOf,
  askModelImpl = askModel, dsh = null, log = console, now = Date.now,
}) {
  let state = loadState() || {}
  const pendingL1 = new Set()
  const retryL1After = new Map()

  const pipeOf = (key) => state[key] || EMPTY
  function putPipe(key, patch) {
    state = { ...state, [key]: { ...EMPTY, ...(state[key] || {}), ...patch } }
    saveState(state)
    return state[key]
  }

  const distillCfg = () => {
    const cfg = config() || {}
    return {
      enabled: cfg.enabled !== false && cfg.memory?.distill !== false && cfg.memory?.distillPipeline !== false,
      threshold: Math.max(5, Number(cfg.memory?.distillBatch) || 10),
      model: cfg.memory?.distillModel || { provider: '', model: '' },
      timeoutMs: Math.max(1, Number(cfg.memory?.distillTimeoutMs) || 120_000),
      retryMs: Math.max(0, Number(cfg.memory?.distillRetryMs ?? 300_000) || 0),
    }
  }

  /** 蒸馏用模型调用：distillModel 配了就走它（小成本），留空跟随主模型。 */
  async function askDistillModel(prompt, maxTokens = 1200) {
    const cfg = config() || {}
    const dc = distillCfg()
    const model = dc.model || {}
    const merged = { ...cfg, model: { ...(cfg.model || {}), ...model } }
    return withAbortTimeout(
      (signal) => askModelImpl(dsh, { cfg: merged, ...prompt, maxTokens, temperature: 0.3, signal }),
      dc.timeoutMs,
      '蒸馏请求',
    )
  }

  /** L0 计数入口：目标对象在群里说话才计数；攒够一批触发后台 L1（不阻塞）。 */
  function noteMessage(chatId, uid, t = now()) {
    const dc = distillCfg()
    if (!dc.enabled) return
    const cid = String(chatId || '')
    if (!cid.startsWith('group:')) return
    const gid = cid.slice(6)
    const u = String(uid || '')
    if (!gid || !u) return
    const target = targetsOf().find((x) => String(x.gid) === gid && String(x.uid) === u)
    if (!target) return
    const key = `${gid}#${u}`
    const p = pipeOf(key)
    const newCount = (p.newCount || 0) + 1
    putPipe(key, { newCount, samples: [...(p.samples || []), Number(t) || now()].slice(-400) })
    if (!shouldTriggerL1({ newCount, lastL1At: p.lastL1At }, { threshold: dc.threshold, now: now() })) return
    if (now() < Number(retryL1After.get(key) || 0)) return
    putPipe(key, { newCount: 0 })
    if (pendingL1.has(key)) return
    pendingL1.add(key)
    Promise.resolve()
      .then(() => runL1(gid, u, target))
      .then(() => retryL1After.delete(key))
      .catch((error) => {
        retryL1After.set(key, now() + dc.retryMs)
        log.warn?.(`蒸馏L1（${target.name || u}）失败：`, error.message)
      })
      .finally(() => pendingL1.delete(key))
  }

  /** L1：最近群流水 → 语言/话题特征（LLM）+ 行为统计（代码）→ 一批原子特征。 */
  async function runL1(gid, uid, target) {
    const dc = distillCfg()
    if (!dc.enabled) return
    const key = `${gid}#${uid}`
    const name = target?.name || uid
    let lines = []
    for (const d of (chatLogDays?.() || []).slice(-2)) {
      for (const l of (chatLogOf?.(d) || [])) {
        if (String(l.chatId) === `group:${gid}`) lines.push(l)
      }
    }
    if (!lines.length) return
    const mine = collectMemberLines(lines, uid)
    if (!enoughEvidence(mine, { minMessages: 5, minChars: 40 })) {
      log.debug?.(`蒸馏L1（${name}）：本批原话只有 ${mine.length} 句，证据不足跳过`)
      return
    }
    const batchId = `b-${now().toString(36)}`
    const stats = behaviorStats(lines, uid)
    const context = dedupConvo(lines.map((l) => ({ uid: l.uid, name: l.name || l.uid || '', text: String(l.text || '') }))).slice(-40)
    const prompt = buildL1Prompt({
      uid, batchId,
      messages: mine.slice(-14).map((x) => x.text),
      context,
      behaviorDigest: renderBehaviorDigest(stats),
    })
    let out = ''
    try {
      out = await askDistillModel(prompt)
    } catch (error) {
      log.warn?.(`蒸馏L1（${name}）模型调用失败：`, error.message)
      return
    }
    const rec = parseL1(out, { uid, batchId })
    if (!rec) {
      log.warn?.(`蒸馏L1（${name}）回包解析失败，前 120 字：`, String(out).slice(0, 120))
      return
    }
    const p = pipeOf(key)
    const batches = [...(p.batches || []), rec].slice(-8)
    const sinceL2 = (p.batchesSinceL2 || 0) + 1
    const willL2 = shouldTriggerL2({ batches, batchesSinceL2: sinceL2 }, { batches: 5 })
    putPipe(key, { batches, batchesSinceL2: willL2 ? 0 : sinceL2, lastL1At: now(), behavior: stats })
    log.info?.(`蒸馏L1：${name} 第 ${batches.length} 批（语言 ${rec.language_features.length} 条、话题 ${rec.topic_features.length} 条）`)
    if (willL2) await runL2(gid, uid, target)
  }

  /** L2：累计 5 批 → 三场景行为模板。 */
  async function runL2(gid, uid, target) {
    const dc = distillCfg()
    if (!dc.enabled) return
    const key = `${gid}#${uid}`
    const name = target?.name || uid
    const p = pipeOf(key)
    if (!(p.batches || []).length) return
    const prompt = buildL2Prompt({ uid, l1List: p.batches, behaviorDigest: renderBehaviorDigest(p.behavior) })
    let out = ''
    try {
      out = await askDistillModel(prompt, 1600)
    } catch (error) {
      log.warn?.(`蒸馏L2（${name}）模型调用失败：`, error.message)
      return
    }
    const rec = parseL2(out, { uid })
    if (!rec) {
      log.warn?.(`蒸馏L2（${name}）回包解析失败，前 120 字：`, String(out).slice(0, 120))
      return
    }
    putPipe(key, { l2: rec, batchesSinceL2: 0 })
    log.info?.(`蒸馏L2：${name} 场景模板已聚合（闲聊/讨论/调侃）`)
  }

  /** L3 每日沉淀：有 L2 模板的目标 → 人格增长段 → emit 增长事件（memory 刷派生卡）。 */
  async function runL3Daily({ onGrowth } = {}) {
    const dc = distillCfg()
    if (!dc.enabled) return 0
    let updated = 0
    for (const t of targetsOf()) {
      const key = `${t.gid}#${t.uid}`
      const p = pipeOf(key)
      if (!p?.l2) continue
      const name = t.name || t.uid
      const prompt = buildL3Prompt({
        uid: t.uid,
        oldSegment: p.l3?.persona_segment || null,
        sceneTemplates: p.l2.scene_templates,
        behaviorDigest: renderBehaviorDigest(p.behavior),
      })
      try {
        const out = await askDistillModel(prompt, 1600)
        const seg = parseL3(out, { uid: t.uid })
        if (!seg) {
          log.warn?.(`蒸馏L3（${name}）回包解析失败，前 120 字：`, String(out).slice(0, 120))
          continue
        }
        putPipe(key, { l3: seg })
        updated++
        log.info?.(`蒸馏L3：${name} 人格增长段已更新${seg.update_note ? '（' + seg.update_note + '）' : ''}`)
        if (onGrowth) await onGrowth(String(t.gid), t)
      } catch (error) {
        log.warn?.(`蒸馏L3（${name}）失败：`, error.message)
      }
    }
    return updated
  }

  /** 每日一次判定（模块 tick 调用）：过了当日 04 点且今天没跑过就沉淀。 */
  function dailyTick({ onGrowth } = {}) {
    const t = now()
    const day = new Date(t).toDateString()
    if (state.lastL3Day === day) return
    const hour = new Date(t).getHours()
    if (hour < 4) return
    state = { ...state, lastL3Day: day }
    saveState(state)
    return runL3Daily({ onGrowth })
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

  return { noteMessage, runL1, runL2, runL3Daily, dailyTick, status, growthList, renderGrowthSegment }
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
  files: ['features/distill-pipeline.js', 'features/distill.js'],
  setup(api) {
    const stateFile = api.dataDir('pipeline.json')
    let mem = null
    const memoryOf = () => {
      if (mem) return mem
      try { mem = api.use('memory') || null } catch { mem = null }
      return mem
    }
    const engine = createDistillEngine({
      config: api.config,
      targetsOf: () => {
        const m = memoryOf()
        try { return m?.distillList?.() || [] } catch { return [] }
      },
      loadState: () => { try { return readJson(stateFile) } catch { return null } },
      saveState: (s) => { try { writeJson(stateFile, s) } catch (e) { api.log.warn?.('蒸馏状态保存失败：', e.message) } },
      chatLogDays: () => api.core.hub.chatLogDays?.() || [],
      chatLogOf: (day) => api.core.hub.chatLogOf?.(day) || [],
      askModelImpl: askModel,
      dsh: api.dsh,
      log: api.log,
    })

    // L0 计数：activity 事件（群消息进站即计，目标对象才有效）
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'in') return
        if (a.chatId && a.userId) engine.noteMessage(a.chatId, a.userId)
      } catch (error) { api.log.debug?.('蒸馏消息计数失败：', error.message) }
    })

    // 每日 L3 沉淀 + 学成事件（memory 模块监听后刷新派生卡）
    api.every(60_000, () => {
      engine.dailyTick({
        onGrowth: async (gid) => { api.emit('distill/growth-updated', { gid }) },
      })
    }, '蒸馏每日沉淀')

    // 手动触发面板路由（与 memory 的 /distill/* 同域风格）
    api.route('/distill/pipeline/status', async () => ({ ok: true, status: engine.status() }))
    api.route('/distill/pipeline/run-l3', async () => {
      const n = await engine.runL3Daily({
        onGrowth: async (gid) => { api.emit('distill/growth-updated', { gid }) },
      })
      return { ok: true, updated: n }
    })

    // 面板卡片刷新需要增长段：memory 模块经 api.use('distill') 读取
    return {
      status: () => engine.status(),
      growthList: (gid) => engine.growthList(gid),
      runL3Daily: (opts) => engine.runL3Daily(opts),
    }
  },
}

export default distillModule
