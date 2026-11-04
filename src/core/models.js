/**
 * 把「按 provider 批量取模型」的结果摊平成一个列表。
 *
 * 这里要做两件事，都是面板上能直接看到的问题：
 *
 * 1) 同名重复：DSH 会把同一个 provider 报两遍，同一个模型也可能返回多条，
 *    原来直接 push，下拉里就是两个一模一样的「Hy3」。
 *
 * 2) 视觉版与基础版并存：DSH 常常给同一个模型配两个 provider，
 *    例如 fan / fan-vision（或 mini / mini-vision），模型 id 完全一样，
 *    唯一区别是后者声明了 vision=true。对使用者来说这就是同一个模型，
 *    列两遍纯属重复；而且一旦给每一行都标「能看图」，看起来就像
 *    「所有模型都能看图」，反而误导。
 *
 *    所以按 **model id** 合并成一个条目，vision 取「任一 provider 声明能看图即算能看图」，
 *    并记住那个能看图的 provider 作为 preferred(provider,model)。上层选模型时
 *    优先用 preferred，拿不到才退回任意一个。
 *
 * 注意仍然按 provider::model 去重：真正不同 provider 提供的不同模型不会被并掉。
 *
 * @param {Array<{provider: string, models: Array}>} groups
 * @returns {Array<{provider: string, model: string, vision: boolean,
 *                  providers: string[], raw: any,
 *                  preferred: {provider: string, model: string}}>}
 */
export function dedupeModelList (groups) {
  const byModel = new Map()
  for (const g of groups || []) {
    const provider = g && g.provider
    if (!provider) continue
    for (const m of (g.models || [])) {
      if (!m) continue
      const model = m.id || m.model
      if (!model) continue

      const vision = isVisionCapable(m)
      const hit = byModel.get(model)
      if (!hit) {
        byModel.set(model, {
          provider,
          model,
          vision,
          providers: [provider],
          raw: m,
          preferred: { provider, model },
        })
        continue
      }
      // 同一个模型又出现在另一个 provider 下：合并
      if (!hit.providers.includes(provider)) hit.providers.push(provider)
      if (vision && !hit.vision) {
        // 换成能看图的那个 provider 作为首选：下游要图时得用支持 vision 的那个。
        // 代价是 config 里存的 'fan' 会匹配不上列表里的 'fan-vision' —— 这个由
        // chat-model 的 provider 宽松匹配兜住（base 与 base-vision 视为同一家）。
        hit.vision = true
        hit.provider = provider
        hit.raw = m
        hit.preferred = { provider, model }
      }
    }
  }
  return [...byModel.values()]
}

/** 模型是否声明了能看图。DSH 的字段名可能是 vision / supportsVision / capabilities。 */
function isVisionCapable (m) {
  if (!m) return false
  if (m.vision === true) return true
  if (m.supportsVision === true) return true
  if (Array.isArray(m.capabilities)) return m.capabilities.includes('vision')
  return false
}
