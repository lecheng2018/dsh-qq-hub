// TEXT_LITE 规则收紧（Batch 2 / T2.3）：群参与分级的 text_lite 声明只收紧「自动分条 / 群合包」目标。
//
// 边界（任务书 T2.3）：
//   · 只收紧、不放宽 —— maxBubbles / maxChars 都与现有规则取最小值；
//   · maxChars 只是自动分条目标，不做总文本硬截断，不截坏代码块 / 引用 / 语音 / 报告 / ||| / 非文本段；
//   · 纯函数：返回新对象，绝不修改调用方传入的 rules 或 limits；
//   · 仅 group + participationLevel === 'text_lite' 时由 reply-delivery 调用（must / engaged / 私聊零影响）。

const isPosInt = (v) => Number.isInteger(v) && v >= 1

/**
 * 把插件的 text_lite limits 收敛进现有分条规则。
 * @param {object} rules replyRules() 的产物（maxBubbles / maxChars / softMaxBubbles? / rand / …）
 * @param {object|undefined} limits 规范化后的 participation.limits（maxBubbles 1~12 / maxChars 10~500）
 * @returns {object} 收紧后的**新**规则对象
 */
export function applyTextLiteRules(rules, limits) {
  const out = { ...(rules || {}) }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return out
  // maxBubbles：与现有硬顶取最小正整数（硬顶语义与面板配置一致）
  const maxBubbles = limits.maxBubbles
  if (isPosInt(maxBubbles)) {
    const cur = Number(out.maxBubbles)
    out.maxBubbles = isPosInt(cur) ? Math.min(cur, maxBubbles) : maxBubbles
    // softMaxBubbles：原值有效则三者取最小（= min(原软顶, 收紧后的硬顶)）；不存在时用收紧后的 maxBubbles。
    // bubbleLimit 的口径是「软顶只压自动切出来的气泡，显式 ||| 至少放出自己那条（仍受硬顶约束）」。
    const soft = Number(out.softMaxBubbles)
    out.softMaxBubbles = isPosInt(soft) ? Math.min(soft, out.maxBubbles) : out.maxBubbles
  }
  // maxChars：与现有规则取最小值 —— 只是自动分条目标收紧，绝不意味着对总输出做硬截断。
  const maxChars = limits.maxChars
  if (isPosInt(maxChars)) {
    const cur = Number(out.maxChars)
    out.maxChars = Number.isFinite(cur) && cur >= 1 ? Math.min(cur, maxChars) : maxChars
  }
  return out
}
