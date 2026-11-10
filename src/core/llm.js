// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。

import { randomUUID } from 'node:crypto'
import { DESCRIBE_SYSTEM, describePrompt, describeText, wrapForMain } from './vision-helper.js'

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- 视觉能力 ----------
//
// 模型能不能看图写在 DSH 的模型元数据里（inputModalities，DSH 自己的图片入口也靠它判断）。
// 三态：true = 明确声明支持；false = 明确声明不支持；null = 宿主没说清楚（按现状照发，别乱降级）。
// 明确不支持时还硬塞图片块，整轮请求会被模型拒掉 —— 她就一个字都回不了。

const VISION_TTL = 10 * 60_000
const visionCache = new Map() // `provider::model` → { at, value }

// 「被模型拒收过图片」的模型：元数据没说，但真发图会被拒。照 reasoning effort 的做法，
// 失败一次就记住，之后直接按「不支持」处理，不用每次都先失败一轮。
// 只在进程内记（重启自动忘），因为元数据可能随 DSH 升级而补全。
const visionRejected = new Set()

/** 清空视觉能力缓存（含「被拒收过」的记忆）。测试与面板改设置时用。 */
export function clearVisionCache () {
  visionCache.clear()
  visionRejected.clear()
}

/**
 * 记下「这个模型收到图片会被拒」。下一次 modelVision 直接返回 false。
 * 给 askModel 的图片降级重试用；单独调用也可以（例如调用方自己探到了拒收）。
 */
export function markVisionUnsupported (provider, model) {
  if (!provider || !model) return
  const key = `${provider}::${model}`
  visionRejected.add(key)
  visionCache.set(key, { at: Date.now(), value: false })
}

/** 这个模型是不是被记成「发图会被拒」了。 */
export function visionRejectedFor (provider, model) {
  return visionRejected.has(`${provider}::${model}`)
}

/** 这个模型能看图吗。null = 不知道。 */
export async function modelVision (dsh, provider, model) {
  const key = `${provider}::${model}`
  // 被模型真实拒收过 → 无论元数据怎么说都不再发图（元数据滞后于实际能力时这是唯一可靠信号）
  if (visionRejected.has(key)) return false
  const hit = visionCache.get(key)
  if (hit && Date.now() - hit.at < VISION_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const mods = info && info.inputModalities
      if (Array.isArray(mods)) value = mods.includes('image')
    }
  } catch (error) {}
  visionCache.set(key, { at: Date.now(), value })
  return value
}

/** 当前设置里的模型能看图吗。面板上「视觉能力」可以手动声明，覆盖元数据。null = 不知道。 */
export async function canSeeImages (dsh, cfg) {
  const v = cfg && cfg.model && cfg.model.vision
  if (v === 'on') return true
  if (v === 'off') return false
  const t = defaultModel(dsh, cfg)
  if (!t) return null
  return modelVision(dsh, t.provider, t.model)
}

// ---------- 思考强度 ----------
//
// 不是所有模型都支持「思考强度」：DSH 里没有推理元数据的模型（本地 Ollama 的那几个、一些手写的
// provider）只要收到 reasoningEffort 就整轮报错 UNSUPPORTED_REASONING_EFFORT。所以传之前先问
// DSH 这个模型支持哪几档，不支持就干脆不传这个参数。

const REASONING_TTL = 10 * 60_000
const reasoningCache = new Map() // `provider::model` → { at, value }

export function clearReasoningCache () {
  reasoningCache.clear()
}

function cacheReasoning (provider, model, value) {
  reasoningCache.set(`${provider}::${model}`, { at: Date.now(), value })
}

/**
 * 这个模型支持哪些思考强度。
 * @returns {Promise<{efforts:string[], default?:string}|null>} 不支持（没有推理元数据）返回 null
 */
export async function modelReasoning (dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = reasoningCache.get(key)
  if (hit && Date.now() - hit.at < REASONING_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const r = info && info.reasoning
      if (r && Array.isArray(r.efforts) && r.efforts.length) {
        value = {
          efforts: r.efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean),
          ...(r.defaultEffort ? { default: String(r.defaultEffort) } : {}),
        }
        if (!value.efforts.length) value = null
      }
    }
  } catch (error) {
    value = null // 查不到就当不支持：少传一个参数，总比整轮报错强
  }
  cacheReasoning(provider, model, value)
  return value
}

/** 把想要的档位收敛成这个模型真正支持的；给 '' / 不支持时返回 undefined（= 不传）。 */
export async function pickReasoningEffort (dsh, provider, model, want) {
  const llm = dsh.llm || dsh.get('llm')
  const canProbe = Boolean(llm && typeof llm.resolveModelInfo === 'function')
  const r = await modelReasoning(dsh, provider, model)
  if (!r) {
    // 宿主根本没有查询接口时（老版本 DSH）维持老行为：照传，由下方的「被拒就重试」兜底。
    // 有接口且查到「不支持」，才真的不传。
    if (!canProbe) return String(want || '') || undefined
    return undefined
  }
  const w = String(want || '')
  if (w && r.efforts.includes(w)) return w
  return r.default && r.efforts.includes(r.default) ? r.default : undefined
}

const isUnsupportedEffort = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(msg)
}

/**
 * 这次报错是不是「模型不收图片」。各家措辞不同：
 *   OpenAI 系：Invalid content type / expected text / image_url is not supported
 *   Anthropic：image ... not supported / does not support images
 *   国内网关：multimodal not supported / content must be text / 不支持图片 / 不支持多媒体
 * 判定保守：只认明确和「图/多模态」相关的错误，避免把普通报错误判成看图失败。
 */
const isImageRejected = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  if (!msg) return false
  if (/image_input|image_url|input_image|multimodal|multi-modal/i.test(msg)) return true
  if (/不支持(图片|图像|多模态|视觉)/.test(msg)) return true
  return /\bimage(s)?\b/i.test(msg) && /not support|unsupported|invalid|cannot|can't|must be text|expect(ed)? text/i.test(msg)
}

async function runStream (llm, params) {
  let out = ''
  for await (const chunk of llm.stream(params)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      const error = new Error('模型报错：' + (f.message || f.code || '未知'))
      if (f.code) error.code = f.code
      throw error
    }
  }
  return out.trim()
}

/**
 * 主模型看不了图时，请辅助视觉模型「看一眼」，返回一段文字描述。
 * 没配 / 关着 / 调用失败都返回空串，绝不抛——调用方据此退回纯文字。
 * @returns {Promise<string>} 空串表示转述失败
 */
export async function describeWithHelper (dsh, { images, cfg, hint, log }) {
  const h = cfg && cfg.visionHelper
  if (!h || !h.enabled || !h.provider || !h.model) return ''
  if (!images || !images.length) return ''
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') return ''
  const take = images.slice(0, Math.max(1, Number(h.maxImages) || 4))
  try {
    let content = [{ type: 'text', text: describePrompt({ count: take.length, hint }) }]
    for (const img of take) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'qq-hub-helper' })
    // 图片要先登记成 DSH 附件块；失败则这次转述直接放弃（返回空串），
    // 由 textForBlindModel 如实告知看不到，绝不把裸 base64 塞给适配层。
    // 线上 EACCES 根因由 fnos-fsync-patch.js 在插件启动时修好，正常不会再走到这里。
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') return ''
    try {
      content = await att.admitPromptContent(content)
    } catch (error) {
      // DSH 底层适配层（dsh-llm-pi-ai）强依赖 block.attachment.attachmentId，
      // 登记附件一旦失败不能强行传裸图片块调用 runStream，否则会抛 Cannot read properties of undefined (reading 'attachmentId')
      log?.warn?.(`辅助看图：图片登记附件失败（${error.message}），跳过调用避免 DSH 框架抛 attachmentId 异常`)
      return ''
    }
    const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'qq-hub' } }]
    const out = await runStream(llm, {
      provider: h.provider,
      model: h.model,
      system: DESCRIBE_SYSTEM,
      messages,
      maxTokens: 1200,
      temperature: 0.2,
    })
    return describeText(out, h.maxChars)
  } catch (error) {
    // 辅助模型挂了不能拖垮主流程：记一条，退回纯文字
    log?.warn?.(`辅助看图模型失败（${h.provider}/${h.model}）：${error.message}`)
    // 只有当模型真正返回拒收图片的错误时，才记录该模型不支持视觉；本地 JS 异常或附件异常绝不误杀模型能力
    if (/image.*not supported|invalid content type|unsupported.*image/i.test(error.message)) {
      markVisionUnsupported(h.provider, h.model)
    }
    return ''
  }
}

/**
 * 主模型看不了图时，这一轮该给它什么文字。
 * 配了辅助模型 → 转述内容 + 来源标注；没配或转述失败 → 一句如实的说明。
 * 两条路径（一开始就知道看不了 / 发了才被拒）共用这一份逻辑，避免两套写法。
 */
export async function textForBlindModel (dsh, o, target) {
  const h = o.cfg && o.cfg.visionHelper
  const usable = h && h.enabled && h.provider && h.model && !(h.provider === target.provider && h.model === target.model)
  const images = o.images || []
  if (usable && images.length) {
    const description = await describeWithHelper(dsh, { images, cfg: o.cfg, hint: o.text, log: o.log })
    if (description) return o.text + '\n' + wrapForMain(description, { count: images.length })
  }
  return o.text + '\n（对方发了图片，但你现在看不到，也读不到描述）'
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, reasoningEffort?:string, cfg?:object, signal?:AbortSignal}} o
 * @returns {Promise<string>}
 */
export async function askModel (dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = { ...defaultModel(dsh, o.cfg) }
  // 调用方显式指定 provider/model 时优先（如 token-guardian 摘要用聊天当前模型，P1-5）
  if (o.provider && o.model) { t.provider = o.provider; t.model = o.model }
  if (!t.provider || !t.model) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: o.text }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'qq-hub-image' })
  // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件。
  // 登记失败（常见：工作区目录不可写 → EACCES）不该让整个后台任务炸掉——
  // 聊天主链路（hub.js admit）和工具配图（img.js）都是「降级成纯文字」，
  // 这里原来是直接抛，导致表情起名这类后台小任务每次失败都刷一条 warn。
  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') {
      content = [{ type: 'text', text: o.text }]
    } else {
      try {
        content = await att.admitPromptContent(content)
      } catch (error) {
        // 图给不进去就只发文字，让调用方自己决定要不要用这个结果
        content = [{ type: 'text', text: o.text }]
        const warn = typeof o.onImageError === 'function' ? o.onImageError : null
        if (warn) warn(error)
      }
    }
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'qq-hub' } }]
  const base = {
    provider: t.provider,
    model: t.model,
    system: o.system || '',
    messages,
    maxTokens: o.maxTokens || 600,
    temperature: o.temperature ?? 0.3,
  }
  // 主模型看不了图（面板声明 off / 元数据说不支持 / 之前被真实拒收过）且配了辅助模型：
  // 先请辅助模型把画面转述成文字，再让主模型读文字。这样文字对话能力完全不受影响。
  // 注意：只在「明确不支持」时才走这条路；不知道（null）仍然先按原样发，交给下面的拒收自愈处理。
  const imgCount = (o.images || []).length
  if (imgCount && (await canSeeImages(dsh, o.cfg)) === false) {
    content = [{ type: 'text', text: await textForBlindModel(dsh, o, t) }]
    base.messages = [{ ...messages[0], content }]
  }
  let effort = await pickReasoningEffort(dsh, t.provider, t.model, o.reasoningEffort === undefined ? 'low' : o.reasoningEffort)
  const hasImage = content.length > 1
  let droppedImage = false
  let retriedEmpty = false
  for (let attempt = 0; ; attempt++) {
    try {
      const params = effort ? { ...base, reasoningEffort: effort } : { ...base }
      if (o.signal) params.signal = o.signal
      const out = await runStream(llm, params)
      // 推理模型偶发「只思考不答题」：流正常结束、usage 有输出 token，但正文 0 字
      //（思考把轮次吃满，正文一个字没写）。重试一次，并把「直接给结果」写进正文请求里压一压。
      if (!out && !retriedEmpty && !imgCount) {
        retriedEmpty = true
        base.messages = [{ ...messages[0], content: [{ type: 'text', text: o.text + '\n\n（上一轮没有输出正文，直接写出结果本身，不要只分析。）' }] }]
        continue
      }
      return out
    } catch (error) {
      // 能力探测没查到 / 模型临时不认：去掉思考强度再来一次
      if (attempt === 0 && effort && isUnsupportedEffort(error)) {
        cacheReasoning(t.provider, t.model, null)
        effort = undefined
        continue
      }
      // 元数据没说、但模型收到图就拒（DeepSeek 这类没声明 inputModalities 的最常见）：
      // 记住这个模型看不了图，去掉图片再来一次，让调用方至少拿到文字回复。
      if (!droppedImage && hasImage && isImageRejected(error)) {
        markVisionUnsupported(t.provider, t.model)
        droppedImage = true
        // 主模型刚被证实看不了图：如果有辅助模型，立刻转述一次，别让这轮白丢图
        content = [{ type: 'text', text: await textForBlindModel(dsh, o, t) }]
        base.messages = [{ ...messages[0], content }]
        const warn = typeof o.onImageError === 'function' ? o.onImageError : null
        if (warn) warn(error)
        continue
      }
      throw error
    }
  }
}
