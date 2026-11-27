// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//     （也接受昵称 / QQ 号：`<reply:初恋>`、`<reply:900000014>`——模型不必记数字，
//      行内出现「↳转述…」时按名字引用真正说话的人，比算编号不容易挂错人）
//   - `<report>…</report>` 包住的内容是「数据报告」：只洗 Markdown、整段发出，不按聊天分条
//     （1.3.48。忘了写标记但这一轮调过内容型工具时，hub 会兜底整段发，见 CONTENT_TOOLS）
//   - `<inner>…</inner>` 是心智独白（【意图】【闭环】【情感】【备忘】）：只给状态机消费，
//     出站 100% 剥离，超长块触发 no-close 保护（v3.4 Phase 1，见 extractAndStripInnerMonologue）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。
//
// 薄门面：实现按职责拆在 reply-sanitize / reply-markdown / reply-document / reply-segment，
// 本文件仅重新导出全部既有公共接口，保证调用方与单测零破坏。

export {
  SILENCE,
  MAX_INNER_CHARS,
  stripReasoning,
  stripUnmarkedThinking,
  extractAndStripInnerMonologue,
  stripInternalMemo,
  stripInterruptNotice,
  sanitizeOutbound,
  isSilence,
} from './reply-sanitize.js'

export {
  convertMarkdownTables,
  stripMarkdown,
} from './reply-markdown.js'

export {
  splitDocumentBySections,
} from './reply-document.js'

export {
  parseReply,
  bubbleLimit,
  capBubbles,
  segmentUnits,
  mergeUnits,
  segmentBubbles,
  splitLines,
  replyRules,
  wantsVoice,
  bubbleDelay,
} from './reply-segment.js'
