// 移植自 h-D-ACE/dsh-qq 的 v2-wait.js：话说完了吗（Complete Guard）
//
// dsh-qq 的 looksLikeUnfinished：模型被 max-tokens 截断时，末尾往往停在
// 「因为……」「然后……」「1.」「首先」这类连接词上，自己察觉不到，QQ 里就是
// 一句说一半的话。它的做法是把这类结尾识别出来，让模型接着说完。
//
// aurabot 里 DSH 的 turn/end 已经带了 reason.kind（'max-tokens' 等），
// 但那段逻辑写死在 hub.js 里。这个模块用纯函数做同样的判断，并对外暴露
// shouldContinue(text, reasonKind) 给别的模块/面板用，同时把判断结果记到日志，
// 让人一眼看出「这次是不是被截断了」。

/** 结尾停在明显的「话没说完」上：连接词、逗号顿号、列举序号、未闭合括号。 */
const UNFINISHED_TAIL = /(?:但是|不过|然而|所以|因为|而且|并且|然后|就是|例如|比如|具体来说|首先|其次|另外|还有|或者是|以及|于是|那么|如果|虽然|虽然但是|甚至|包括)[，,、\s]*$/
const TRAILING_COMMA = /[，,、；;：:]\s*$/
const DANGLING_NUMBERING = /(?:^|\n)\s*(?:\d{1,2}[.、)]|[一二三四五六七八九十]+[、.）)])\s*$/
const UNCLOSED_BRACKET = /(?:「[^」]*$|『[^』]*$|（[^）]*$|\([^)]*$|【[^】]*$)/

/**
 * 这段回复看起来还没说完吗？
 * @param {string} text 回复正文
 * @param {string} [reasonKind] DSH 给的结束原因（'completed' / 'max-tokens' / 'aborted' …）
 * @returns {{ unfinished: boolean, why: string }}
 */
export function looksLikeUnfinished(text, reasonKind = '') {
  const t = String(text || '').trim()
  if (!t) return { unfinished: false, why: '空' }
  if (reasonKind && reasonKind !== 'completed') return { unfinished: true, why: `这一轮没正常结束（${reasonKind}）` }
  if (UNCLOSED_BRACKET.test(t)) return { unfinished: true, why: '括号 / 引号没闭合' }
  if (DANGLING_NUMBERING.test(t)) return { unfinished: true, why: '停在列举序号上' }
  if (UNFINISHED_TAIL.test(t)) return { unfinished: true, why: '停在连接词上' }
  // 只在明显偏长时按「逗号收尾」判，短句里以逗号结尾很常见（很自然）
  if (t.length > 80 && TRAILING_COMMA.test(t)) return { unfinished: true, why: '长回复以逗号收尾' }
  return { unfinished: false, why: '' }
}

export default {
  id: 'complete-guard',
  name: '话说完没',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：识别被截断的回复（停在「因为」「1.」上），提醒模型接着说',
  tab: 'model',
  defaults: {
    enabled: true,
    /** 检测到没说完时，是否在日志里显式告警（面板「日志」页能看到） */
    warnInLog: true,
    /** 同一聊天里连续触发多少次后不再刷日志 */
    maxWarnsPerChat: 3,
  },
  settings: [
    { key: 'enabled', label: '启用截断检测', type: 'switch', hint: '开着只做检测和日志，不改她的回复' },
    { key: 'warnInLog', label: '在日志里告警', type: 'switch' },
    { key: 'maxWarnsPerChat', label: '每个聊天最多告警几次', type: 'number', min: 0, max: 20, step: 1 },
  ],
  setup(api) {
    const warned = new Map() // chatId → 次数
    const lastResult = new Map() // chatId → { at, unfinished, why }

    // 她的每段回复都过一遍（只看不改）
    api.on('reply', (text, info) => {
      const cfg = api.settings()
      if (!cfg.enabled) return undefined
      const chatId = String(info?.chatId || '')
      const r = looksLikeUnfinished(text, '')
      lastResult.set(chatId, { at: Date.now(), ...r })
      if (r.unfinished && cfg.warnInLog) {
        const n = (warned.get(chatId) || 0) + 1
        warned.set(chatId, n)
        if (n <= Number(cfg.maxWarnsPerChat)) api.log.warn(`${chatId} 这段回复可能没说完整（${r.why}）：…${String(text).slice(-30)}`)
      }
      return undefined // 不改她的回复
    })

    // 给她一条规则：一次说不完就先说完，别把句子留在连接词上
    api.rule(() => '一次没说完的长内容，先说结论、分点讲；如果确实太长，先说「我分两段说」，不要停在「因为」「然后」这种半句上。')

    // 面板 / 别的模块可以直接问
    api.route('/complete-guard/last', (req) => ({ ok: true, items: Object.fromEntries(lastResult) }))

    return {
      looksLikeUnfinished,
      last: (chatId) => lastResult.get(String(chatId)) || null,
      all: () => Object.fromEntries(lastResult),
    }
  },
}
