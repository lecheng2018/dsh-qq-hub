// 「她正忙着吗」的状态（1.3.57，hub 状态所有权重构第三批）。
//
// 两个关心点混在 hub 里，各处都要自己判：
//   · busy —— 这个聊天她正在想/正在发（连发合并的闸门、压缩要避让、插话要避让都用它）。
//     以前每个调用点自己写 `busy.has(x) && Date.now() - busy.get(x) < BUSY_MAX_MS`。
//   · typing —— 私聊里给 QQ 报「对方正在输入…」，靠一个 setInterval 维持，忘了停会一直提醒。
//
// 收进来的意义在于**卡住保护只有一处**：busy 超过 4 分钟自动算「她已经回完了」，
// 不然一次异常退出会把那个聊天的连发合并永久卡死（以前这个常量散在 isBusy 里，
// 任何新写的调用点都可能忘记判超时）。typing 的计时器也归它管，谁起谁停不会漏。

const BUSY_MAX_MS = 4 * 60_000 // 卡住保护：超过这么久就当她已经回完了

export function createActivityState({ onTypingPing } = {}) {
  const busy = new Map() // chatId → 这一轮开始的时间
  const typing = new Map() // sessionKey → interval 计时器

  return {
    /** 这个聊天她是不是正忙着一轮（含卡住保护）。 */
    isBusy (chatId, now = Date.now()) {
      const at = busy.get(String(chatId))
      return Boolean(at) && now - at < BUSY_MAX_MS
    },
    /** 标记「这一轮开始了」。 */
    markBusy (chatId, now = Date.now()) {
      const id = String(chatId)
      if (!id) return
      busy.set(id, now)
    },
    /** 这一轮结束了（或者她没说话）：放开，允许下一批进来。 */
    release (chatId) {
      busy.delete(String(chatId))
    },

    /**
     * 私聊里开始显示「对方正在输入…」。
     * @param {string} key      sessionKey
     * @param {object} chat     要判断 kind === 'private'
     * @param {{enabled:boolean, dryRun:boolean}} cfg
     * @param {(userId:string) => void} ping 真正发状态的动作（由 hub 注入，模块不碰 onebot）
     */
    startTyping (key, chat, cfg, ping) {
      if (!key || !chat || chat.kind !== 'private') return
      if (!cfg || !cfg.enabled || cfg.dryRun) return
      if (typing.has(key)) return // 已经在显示，别叠计时器
      const doPing = () => { try { ping?.(chat.userId) } catch {} ; try { onTypingPing?.(chat) } catch {} }
      doPing()
      const started = Date.now()
      const t = setInterval(() => {
        // 上限 6 分钟：模型卡死时别一直挂「正在输入」误导对方
        if (Date.now() - started > 6 * 60_000) { stopTyping(key); return }
        doPing()
      }, 15_000)
      t.unref?.()
      typing.set(key, t)
    },
    stopTyping (key) {
      stopTyping(key)
    },

    /** 排查/测试用。 */
    size () {
      return { busy: busy.size, typing: typing.size }
    },
  }

  function stopTyping (key) {
    const t = typing.get(key)
    if (t) clearInterval(t)
    typing.delete(key)
  }
}

export { BUSY_MAX_MS }
