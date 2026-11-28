// 敏感字段注册、路径索引、脱敏回显与 B 站 Cookie 解析。

import { isObj } from './config-defaults.js'

// 面板里不回传原文的字段：路径（几层都行）
export const SECRETS = [
  ['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'],
  ['imageGen', 'apiKey'],
  // 语音引擎的云端凭据：豆包 / 百炼 / MiMo（掩码 + 留空保存保留原值，同 imageGen 口径）
  ['voice', 'doubao', 'apiKey'],
  ['voice', 'qwentts', 'apiKey'],
  ['voice', 'mimo', 'apiKey'],
  ['bili', 'cookie'], ['bili', 'sessdata'], ['bili', 'biliJct'],
  ['heybox', 'cookie'], ['bridge', 'token'],
  ['multiParser', 'cookies', 'bilibili'],
  ['multiParser', 'cookies', 'weibo'],
  ['multiParser', 'cookies', 'redbook'],
  ['multiParser', 'cookies', 'zhihu'],
  ['multiParser', 'cookies', 'tieba'],
  ['multiParser', 'cookies', 'douyin'],
  ['multiParser', 'cookies', 'xiaoheihe'],
  // 向量通道 API Key（1.4.5）：模块 password 字段的动态登记（registerSecretField）在运行环境
  // 未生效（memory 是该机制首个使用者，疑似模块实例隔离问题，待查），静态清单双保险：
  // 掩码（publicConfig）与「留空保存保留原值」（mergeFromPanel）都依赖这份清单。
  ['ext', 'memory', 'vectorApiKey'],
  // 审计 S06：动态登记还有一处结构性缺口 —— 内置模块走 startSync 时根本不登记
  // （已在 modules.js 的 prepareStart 修掉）。这里再补静态双保险，覆盖「登记失效」这个
  // 尚未查清的情形：云端 ASR 的 key 与配置文件里的 memory.embeddings.apiKey。
  ['ext', 'voice', 'cloudAsrApiKey'],
  ['memory', 'embeddings', 'apiKey'],
  // 精排 API Key（#146）同口径进静态清单（缺陷：rerankApiKey 漏进 SECRETS，明文回传面板）。
  ['ext', 'memory', 'rerankApiKey'],
  // 审计 S06：通用 HTTP TTS 的请求头与请求体是自由文本字段，但实际用法就是塞
  // 「Authorization: Bearer …」这类凭据（面板模板与 hint 都这么引导）。凭据不应
  // 明文回传面板——走与 apiKey 同一套机制：回显置空 + <k>Set 标记 +
  // 「留空保存保留原值」（mergeFromPanel 通用逻辑已覆盖）。用户要看原文去
  // config.json；面板里重新粘贴/选模板即可整体替换。
  ['voice', 'http', 'headers'],
  ['voice', 'http', 'body'],
]

// 扩展模块设置里的密码类字段（模块加载时登记）：['ext', 模块id, 字段]
const extraSecrets = new Map()

/** 登记扩展模块中的敏感字段路径，用于脱敏回显与留空保存保留原值。 */
export function registerSecretField(path) {
  extraSecrets.set(path.join('\u0000'), path)
}

// 审计 S06：静态清单与模块登记可能指向同一路径（例如内置语音的 cloudAsrApiKey
// 既在 SECRETS 静态兜底、又被 registerSecretField 登记）。重复处理同一个路径会让
// 第二个循环读到已被置空的字段，把 `<k>Set` 覆盖回 false —— 面板显示「没填」，而
// 实际存着值。按路径去重：同一路径只处理一次。
export function allSecrets() {
  const seen = new Set()
  const out = []
  for (const path of [...SECRETS, ...extraSecrets.values()]) {
    const key = path.join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** 获取（或按需创建）路径末段字段的父对象。 */
export function parentOf(obj, path, create) {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) { if (!create) return null; cur[k] = {} }
    cur = cur[k]
  }
  return cur
}

export const getAt = (obj, path) => {
  const p = parentOf(obj, path, false)
  return p ? p[path.at(-1)] : undefined
}

// 这些密钥在面板里显示结尾几位（「已保存（结尾 …a1b2）」），方便认出存的是哪一份；完整值不回传
export const HINTED = [['bili', 'sessdata'], ['bili', 'biliJct']]

/** 从一串 Cookie 里取某个值（「SESSDATA=xxx; bili_jct=yyy」）。 */
export function cookieValue(raw, key) {
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

/**
 * B 站 Cookie 整理成两个值：粘了整串 / 带了「SESSDATA=」前缀的都认得；老配置只有整串的拆开。
 * 返回 {sessdata, biliJct, cookie}，cookie 是拼好给接口用的。
 */
export function splitBiliCookie({ sessdata = '', biliJct = '', cookie = '' } = {}) {
  const a = String(sessdata || '').trim()
  const b = String(biliJct || '').trim()
  // 框里粘的是「xxx=…」这种整串或带前缀的：从里面取；纯值原样用
  const isRaw = (v) => /(^|;\s*)(SESSDATA|bili_jct)=/.test(v)
  let s = isRaw(a) ? '' : a
  let j = isRaw(b) ? '' : b
  for (const v of [a, b]) {
    if (!isRaw(v)) continue
    s = cookieValue(v, 'SESSDATA') || s
    j = cookieValue(v, 'bili_jct') || j
  }
  if (!s && !j && cookie) {
    s = cookieValue(cookie, 'SESSDATA')
    j = cookieValue(cookie, 'bili_jct')
  }
  return { sessdata: s, biliJct: j, cookie: [s && `SESSDATA=${s}`, j && `bili_jct=${j}`].filter(Boolean).join('; ') }
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of HINTED) {
    if (isObj(c[g])) c[g][`${k}Hint`] = c[g][k] ? '…' + String(c[g][k]).slice(-4) : ''
  }
  for (const path of allSecrets()) {
    const p = parentOf(c, path, false)
    if (!p) continue
    const k = path.at(-1)
    p[`${k}Set`] = Boolean(p[k])
    p[k] = ''
  }
  return c
}
