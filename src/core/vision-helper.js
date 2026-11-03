// 辅助看图：主模型不支持多模态时，临时请另一个视觉模型「看一眼」，把画面转成文字。
//
// 为什么不做成「悄悄替换图片」：
//   1) 转述会有信息损失，主模型必须知道这段是别人转述的，不能当成亲眼所见；
//   2) 描述要标注来源，否则她会把「别人看到的」当成「我记得的」写进记忆；
//   3) 一次请求只转述一次，同一张图不重复花钱。
//
// 这里只放纯函数（提示词、解析、预算裁剪），真正的调用在 llm.js，方便单测。

/** 给辅助模型看的系统提示词：只描述客观看到的东西，不猜、不评价、不带情绪。 */
export const DESCRIBE_SYSTEM = [
  '你只负责把图片内容如实转成文字，供看不见图的人阅读。',
  '要求：',
  '1) 先一句总述这是什么（照片 / 截图 / 表情包 / 聊天记录 / 文档……）。',
  '2) 再写关键细节：人物、动作、场景、图中的文字（原样抄下来，不要翻译）。',
  '3) 如果是表情包，说明它表达的情绪/梗，以及画面里的主体。',
  '4) 如果是截图或文档，把可读的文字按顺序写出来。',
  '5) 只写你确实看到的。看不清就说看不清，绝不猜测、不补全、不编造。',
  '6) 不要评价、不要加语气词、不要输出 Markdown 标题。',
].join('\n')

/** 拼一次转述请求的正文。 */
export function describePrompt ({ count = 1, hint = '' } = {}) {
  const n = Math.max(1, Number(count) || 1)
  const head = n > 1 ? `这里有 ${n} 张图，请按顺序分别描述，每张前面标 [图1] [图2]……` : '请描述这张图。'
  const tail = hint ? `\n（发送者附带的说明：${String(hint).slice(0, 200)}）` : ''
  return head + tail
}

/**
 * 把辅助模型的输出整理成一段可以直接拼进提示词的文字。
 * 保留原文，只做长度裁剪和空白归一；失败或空输出返回空串（调用方据此降级）。
 */
export function describeText (raw, maxChars = 600) {
  const text = String(raw || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return ''
  const limit = Math.max(50, Number(maxChars) || 600)
  if (text.length <= limit) return text
  return text.slice(0, limit).replace(/[，。、；：,\s]+$/, '') + '……（描述已截断）'
}

/**
 * 把「别人看到的画面」包装成给主模型的说明。
 * 明确标注这不是她自己看到的，避免她把转述当成亲眼所见、或写进记忆。
 */
export function wrapForMain (description, { count = 1 } = {}) {
  const d = String(description || '').trim()
  if (!d) return ''
  const n = Math.max(1, Number(count) || 1)
  return [
    `（${n > 1 ? `${n} 张图片` : '这张图片'}你本人看不到，是另一个模型看过之后转述给你的，`,
    '内容如下，可以参考，但别当成你亲眼见过：',
    d,
    '）',
  ].join('')
}
