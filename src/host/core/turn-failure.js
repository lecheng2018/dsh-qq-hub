// 回合失败处理：超时、请求体过大（413 / 插件内存上限）、被宿主归档门拦下（blocked）。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致：文案、时序、标记集合都没动）。
// 三者同一条纪律：**这里只记标记 + 提示用户**，真正的归档重建（resetChat）留到下一条
// 消息进入 execute 时做 —— 回合失败路径此刻事件监听还没走完，立刻归档会和宿主自己的
// 事件处理打架（原注释见各函数）。
//
// 依赖：outbox 走 getOutbox 取数函数（它在本模块装配之后创建）；三个「待归档」标记集合
// 由核心持有并**以活引用传入**——execute / runPromptTurn 读同一份标记决定是否换会话，
// 复制一份就会漂移。

import { redact } from '../../core/redact.js'

export function createTurnFailure({ log, debug, getOutbox, timedOutChats, oversizedChats, archivedChats }) {
  function handleTurnTimeout(chatKey, timeoutMs, { notify = true } = {}) {
    timedOutChats.add(chatKey)
    const minutes = Math.max(1, Math.ceil(timeoutMs / 60000))
    log.warn(`回合超过 ${minutes} 分钟未结束：${chatKey}；已释放等待，下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(getOutbox().request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: `刚才的回复超过 ${minutes} 分钟还没完成，我先停止等待了，这条旧回复不会再补发。你发下一条消息时我会重新开始。` } }],
    })).catch((error) => debug(`回合超时提示没发出去：${error?.message || error}`))
  }

  // ---------- 413 / 请求体过大自愈 ----------
  // DeepSeek 服务端对「会话累计上下文 + 图片字节」有一个按会话计的硬上限（真机 2026-11-19：
  // 413 plugin_request_too_large「本次对话上下文或图片过大……插件内存上限 64 MiB」）。这不是
  // 单次请求能靠删图救回的：旧会话的历史每轮都重放，超限后**之后每一轮都必然 413**，会话
  // 永久卡死。DSH 把 413 归类为 INVALID_REQUEST（不重试），turn/end 落 error，本轮「不发」。
  //
  // 唯一可靠的恢复 = 换新会话（归档旧的，下一条消息自动新建）。与 handleTurnTimeout 同款模式：
  // 这里只记标记 + 提示，真正 resetChat 在下一条消息进入 execute 时做（避免在回合失败路径里
  // 立刻归档——此刻事件监听还没走完，且用户可能正在面板里翻这个会话）。
  //
  // 识别口径（宁可多识别不漏判，因为误伤代价只是多一次归档重建）：
  //   · DSH 结构化失败码：turn/end reason.error.code === 'INVALID_REQUEST' 且 status === 413；
  //   · 服务端错误文案特征：plugin_request_too_large / 「上下文或图片过大」 / 「插件内存上限」；
  //   · 兜底：INVALID_REQUEST 且消息含 too large / 413（防服务端换措辞）。
  // DSH 会话修复（repair.ts）合成的 turn/end 不带 error 细节（只有 kind），那类不是 413，天然不命中。
  const OVERSIZE_MESSAGE_RE = /plugin_request_too_large|上下文或图片过大|插件内存上限|\b413\b|too\s+large/i
  // 服务端「请求体/会话累计过大」的**强特征**。这些词只可能来自「发出去的东西太大」，
  // 不可能来自「模型的 token 上下文窗口不够」，所以不看 code、不看 status 都成立。
  //
  // 为什么必须不看 code（真机 2026-11-20，同一个群连挂 6 轮）：
  //   该聊天的模型走 pi-ai 路由（第三方 OpenAI 兼容提供方），错误分类走 dsh-llm-pi-ai 的
  //   `isContextOverflow()`，而它把 Anthropic 的 /request_too_large/i 当「上下文溢出」——
  //   我们的 `plugin_request_too_large` **正好含这个子串**，于是被判成
  //   `CONTEXT_WINDOW_EXCEEDED`（pi-ai 路径还不填 status）。后果有两层：
  //     ① dsh-compaction-basic 见 code 就压缩重试。但压缩请求本身也要把同一份超大历史
  //        发给模型算摘要，所以它同样 413（真机 compaction/end 的 error 就是同一条 413）——
  //        摘要算不出来、历史字节一个没少，纯空转，还把「该换会话」拖到下一条消息；
  //     ② 本函数的旧口径要求 `INVALID_REQUEST` 或 `status === 413`，两个都不匹配，
  //        自愈一次没触发，会话就一直卡在同一个超限历史里。
  //   所以改成「文案优先」：只要出现这些强特征词就认定是请求体过大。
  const SERVER_OVERSIZE_TEXT = /plugin_request_too_large|request_too_large|context_too_large|请求体过大|上下文或图片过大|插件内存上限|request\s+body\s+too\s+large|payload\s+too\s+large/i
  function turnFailureLooksOversized(failure) {
    if (!failure || typeof failure !== 'object') return false
    const code = String(failure.code || '')
    const status = Number(failure.status) || 0
    const message = String(failure.message || '')
    if (status === 413) return true
    // 文案优先：不依赖 code/status（pi-ai 会把 plugin_request_too_large 误判成上下文超限）
    if (SERVER_OVERSIZE_TEXT.test(message)) return true
    if (code === 'INVALID_REQUEST' && OVERSIZE_MESSAGE_RE.test(message)) return true
    // 某些路径（repair 合成 / 旧宿主）没有 status，只有 message：特征词唯一性足够强
    if (!code && OVERSIZE_MESSAGE_RE.test(message) && /413|过大|too large|too_large/i.test(message)) return true
    return false
  }
  /** 回合因请求体过大失败：记标记、提示用户；下一条消息进入时自动归档重建会话。 */
  function handleOversizedTurn(chatKey, failure, { notify = true } = {}) {
    oversizedChats.add(chatKey)
    const detail = String(failure?.message || '').replace(/\s+/g, ' ').slice(0, 120)
    log.warn(`回合因请求体过大被服务端拒绝（413/插件内存上限）：${chatKey}${detail ? '：' + redact(detail) : ''}；下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(getOutbox().request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: '这个会话攒的上下文和图片太多，服务端拒绝了（超过 64 MiB 上限），这轮没法回。你发下一条消息时我会自动重新开始（旧对话会归档，可以随时找回）；图片类内容也会少带一些。' } }],
    })).catch((error) => debug(`请求体过大提示没发出去：${error?.message || error}`))
  }
  /**
   * 回合被 DSH 归档门拒绝（`turn/end` 的 kind 是 `blocked`）：记标记，下一条消息进来时换新会话。
   *
   * `blocked` 没有 error 细节（不是模型错误、不是 413），所以不能靠 failure 判定，
   * 只能认 kind。它比 413 更"干净"：服务端一次都没被调用，纯粹是宿主拒绝在已归档会话上开步骤。
   * @param {string} chatKey 聊天键。
   */
  function handleArchivedTurn(chatKey) {
    archivedChats.add(chatKey)
    log.warn(`回合被宿主归档门拦下（blocked）：${chatKey} 的会话已归档，下一条消息将换新会话`)
  }

  return { handleTurnTimeout, turnFailureLooksOversized, handleOversizedTurn, handleArchivedTurn }
}
