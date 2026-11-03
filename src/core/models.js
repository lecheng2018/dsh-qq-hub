/**
 * 把「按 provider 批量取模型」的结果摊平成一个列表，并按 provider::model 去重。
 *
 * 为什么要去重：DSH 的 listProviders() 有时会把同一个 provider 报两遍
 * （一次字符串、一次对象），listModels(provider) 也可能对同一个模型返回多条。
 * 原来直接 push 进列表，面板下拉里就会出现两个一模一样的「Hy3 / fan-vision」，
 * 用户以为配错了。
 *
 * 只按 provider::model 去重，不按 provider 整体跳过 —— 同一个 provider
 * 第二次出现时可能带出新的模型，整段跳过会漏。
 *
 * @param {Array<{provider: string, models: Array}>} groups 每个 provider 及它返回的模型
 * @returns {Array<{provider: string, model: string, raw: any}>} 去重后的结果，保持原顺序
 */
export function dedupeModelList (groups) {
  const seen = new Set()
  const out = []
  for (const g of groups || []) {
    const provider = g && g.provider
    if (!provider) continue
    for (const m of (g.models || [])) {
      if (!m) continue
      const model = m.id || m.model
      if (!model) continue
      const k = provider + '::' + model
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ provider, model, raw: m })
    }
  }
  return out
}
