// 辅助看图模型：主模型不支持多模态时，临时请另一个视觉模型转述画面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { askModel, clearVisionCache } = await import(`file:///${REPO}/src/core/llm.js`)
const { describeText, wrapForMain, describePrompt } = await import(`file:///${REPO}/src/core/vision-helper.js`)

const passThrough = { admitPromptContent: async (c) => c }
const IMG = { data: 'AAAA', mediaType: 'image/png' }

/**
 * 造一个双模型 llm：
 *   main  —— 看不了图（元数据只声明 text），收到 image 就抛错
 *   helper—— 能看图，返回一段描述
 * 记录每个模型被调用的次数和收到的图片张数。
 */
function makeLlm ({ helperFails = false } = {}) {
  const calls = []
  return {
    calls,
    async resolveModelInfo (p) {
      return p === 'helper' ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] }
    },
    async *stream (params) {
      const images = (params.messages[0].content || []).filter((c) => c.type === 'image').length
      calls.push({ model: params.model, images })
      if (params.model === 'vlm') {
        if (helperFails) throw new Error('辅助模型炸了')
        yield { type: 'text-delta', text: '一只橘猫趴在键盘上打哈欠' }
        return
      }
      // 主模型：不该收到图
      if (images > 0) throw new Error('image_url is not supported by this model')
      yield { type: 'text-delta', text: '猫猫可爱' }
    },
  }
}

const cfgWith = (helper) => ({
  model: { provider: 'main', model: 'text-only', vision: 'auto' },
  visionHelper: { enabled: true, provider: 'helper', model: 'vlm', maxImages: 4, maxChars: 600, keepOriginal: true, ...helper },
})

test('主模型看不了图 + 配了辅助模型：转述内容进主模型，图片不进', async () => {
  clearVisionCache()
  const llm = makeLlm()
  const dsh = { llm, attachments: passThrough, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? passThrough : null) }
  const out = await askModel(dsh, { cfg: cfgWith({}), text: '看看这个', images: [IMG] })
  assert.equal(out, '猫猫可爱', '应该是主模型的回复')
  // 辅助模型收到 1 张图，主模型收到 0 张
  assert.deepEqual(llm.calls.map((c) => [c.model, c.images]), [['vlm', 1], ['text-only', 0]], '辅助模型看图、主模型读文字')
})

test('转述带来源标注：明确告诉主模型这不是它亲眼看到的', async () => {
  clearVisionCache()
  const llm = makeLlm()
  const sent = []
  const orig = llm.stream
  llm.stream = async function * (params) {
    sent.push({ model: params.model, content: JSON.stringify(params.messages[0].content) })
    yield * orig.call(llm, params)
  }
  const dsh = { llm, attachments: passThrough, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? passThrough : null) }
  await askModel(dsh, { cfg: cfgWith({}), text: '看看这个', images: [IMG] })
  const mainCall = sent.find((x) => x.model === 'text-only')
  assert.ok(mainCall, '主模型应该被调用过')
  assert.match(mainCall.content, /另一个模型看过之后转述/, '必须有来源标注')
  assert.match(mainCall.content, /橘猫/, '转述内容要在里面')
})

test('没配辅助模型：退回一句如实说明，不假装看到了', async () => {
  clearVisionCache()
  const llm = makeLlm()
  let seen = ''
  const origStream = llm.stream
  llm.stream = async function * (params) {
    if (params.model !== 'vlm') seen = JSON.stringify(params.messages[0].content)
    yield * origStream.call(llm, params)
  }
  const dsh = { llm, attachments: passThrough, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? passThrough : null) }
  const out = await askModel(dsh, { cfg: cfgWith({ enabled: false }), text: '看看这个', images: [IMG] })
  assert.equal(out, '猫猫可爱')
  assert.match(seen, /看不到|读不到描述/, '要如实说看不到')
  assert.equal(llm.calls.some((c) => c.model === 'vlm'), false, '没启用时不该调辅助模型')
})

test('辅助模型自己出错：不拖垮这一轮，退回纯文字继续', async () => {
  clearVisionCache()
  const llm = makeLlm({ helperFails: true })
  const dsh = { llm, attachments: passThrough, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? passThrough : null) }
  const out = await askModel(dsh, { cfg: cfgWith({}), text: '看看这个', images: [IMG] })
  assert.equal(out, '猫猫可爱', '辅助模型挂了，主模型仍应正常回复')
})

test('辅助模型和主模型是同一个：不自己转述给自己', async () => {
  clearVisionCache()
  const llm = makeLlm()
  const dsh = { llm, attachments: passThrough, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? passThrough : null) }
  await askModel(dsh, {
    cfg: cfgWith({ provider: 'main', model: 'text-only' }),
    text: '看看这个', images: [IMG],
  })
  assert.equal(llm.calls.some((c) => c.model === 'vlm'), false, '同一个模型不该被当成辅助模型')
})

test('登记附件失败（EACCES）时，askModel 退回纯文字，绝不把裸 base64 块交给 DSH 适配层', async () => {
  // 线上日志：辅助看图模型失败（fan/glm-5.3-flash）：EACCES: permission denied, open '/vol2/@appshare'
  // 真实 DSH 的 collectImageRefs 只认 { attachment: { attachmentId } }，裸 base64 会本地 TypeError。
  // 因此登记失败的正确兜底是：askModel 主链路退回纯文字（由 textForBlindModel 如实说明看不到），
  // 而不是硬发裸块；hub.js 的 admit() / describeWithHelper() 另有真实附件修复路径（fnos-fsync-patch.js）。
  clearVisionCache()
  const llm = makeLlm()
  const eacces = {
    admitPromptContent: async () => { throw new Error("EACCES: permission denied, open '/vol2/@appshare'") },
  }
  let warned = ''
  const dsh = { llm, attachments: eacces, get: (k) => (k === 'llm' ? llm : k === 'attachments' ? eacces : null) }
  const out = await askModel(dsh, { cfg: cfgWith({}), text: '看看这个', images: [IMG], onImageError: (e) => { warned = e.message } })
  assert.equal(out, '猫猫可爱', '主模型仍应正常回复')
  assert.match(warned, /EACCES/, '要通过 onImageError 告知调用方图片没送进去')
  const mainCall = llm.calls.find((c) => c.model === 'text-only')
  assert.ok(mainCall, '主模型必须被调用')
  assert.equal(mainCall.images, 0, '主模型绝不收到裸 base64 图片块')
  assert.equal(llm.calls.some((c) => c.model === 'vlm'), false, '登记失败时不该让辅助模型去踩裸块崩溃')
})

test('describeText：裁剪超长描述，保留原文', () => {
  assert.equal(describeText('短描述', 600), '短描述')
  assert.equal(describeText('', 600), '')
  assert.equal(describeText(null, 600), '')
  const long = '很'.repeat(1000)
  const cut = describeText(long, 100)
  assert.ok(cut.length < 200, '要截断')
  assert.match(cut, /已截断/)
})

test('wrapForMain：标注张数且说明不是亲眼所见', () => {
  assert.equal(wrapForMain('', { count: 1 }), '')
  assert.match(wrapForMain('描述A', { count: 1 }), /这张图片/)
  assert.match(wrapForMain('描述A', { count: 3 }), /3 张图片/)
  assert.match(wrapForMain('描述A', { count: 1 }), /别当成你亲眼见过/)
})

test('describePrompt：多图时要求按顺序编号', () => {
  assert.match(describePrompt({ count: 3 }), /3 张图/)
  assert.match(describePrompt({ count: 3 }), /\[图1\]/)
  assert.match(describePrompt({ count: 1 }), /描述这张图/)
})
