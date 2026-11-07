// QQ Hub · 模型目录（host.js 分层拆出）
//
// DSH 可用模型清单的去重/探测/缓存，面板「模型」页、主人命令 /model、hub 的
// availableModels 兜底共用同一份。

import { dedupeModelList } from '../core/models.js'
import { modelReasoning, modelVision } from '../core/llm.js'

export function createModelDirectory({ ctx }) {
  /**
   * DSH 里能用的所有模型：[{provider, model, name, reasoning}]。
   * reasoning 是 {efforts:[...], default} 或 null（null = 这个模型不支持思考强度，
   * 面板据此把「思考强度」置灰，免得选了之后整轮报错）。
   */
  async function listModels() {
    const llm = ctx.llm || ctx.get('llm')
    const out = []
    // DSH 可能把同一个 provider 报两遍、同一个模型返回多条，面板里就会出现
    // 两个一模一样的「Hy3 / fan-vision」。去重逻辑抽在 core/models.js 里。
    // （1.3.6 就接线了；真正的根因是这份远端修复一直没合并进本地运行的那份。）
    const groups = []
    for (const p of llm.listProviders() || []) {
      const provider = typeof p === 'string' ? p : p.provider || p.id || p.name
      if (!provider) continue
      try {
        groups.push({ provider, models: (await llm.listModels(provider)) || [] })
      } catch (error) {}
    }
    // dedupeModelList 已按 model id 合并掉「基础版 / 视觉版」这种同模型多 provider 的情况，
    // 这里优先用能看图的那个 provider 去问细项；它答不上来再退回任意一个。
    for (const item of dedupeModelList(groups)) {
      const { model, raw } = item
      // 选了能看图的那个 provider 就优先报它，免得下游又把它当看不见图的用
      const provider = item.preferred.provider
      // 合并时已经知道「任一 provider 说能看图」，这里再问一次只是兜底：
      // 只有明确查到 true 才升级，查不到（undefined）保持原判定，绝不因为查不到就把 true 降级。
      let vision = item.vision
      if (!vision) {
        try { if (await modelVision(ctx, provider, model) === true) vision = true } catch (error) {}
      }
      let reasoning = null
      try { reasoning = await modelReasoning(ctx, provider, model) } catch (error) {}
      // providers：合并前的全部来源（面板/诊断能看到这个模型到底挂在几家下）
      out.push({ provider, model, name: raw.name || model, reasoning, vision, providers: item.providers })    }
    if (out.length) modelCache = out
    return out
  }
  // 最近一次查到的模型列表：按聊天选的模型已经不在 DSH 里了，就退回下一级（同步取，hub 每条消息都要用）
  let modelCache = null
  setTimeout(() => { listModels().catch(() => {}) }, 3000).unref?.()
  return {
    listModels,
    get cache () { return modelCache },
  }
}
