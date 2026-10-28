// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { createImageGen } from '../../features/imagegen.js'
import { defineTool, str } from '../../tools/tools.js'
import { mimeOf } from '../../chat/inbound.js'
import { canSeeImages } from '../../core/llm.js'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local })
    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，回复里简单说一句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      render: (_args, value) => [
        { type: 'text', text: value.ok ? value.message : '✗ ' + value.message },
        ...(value.image ? [value.image] : []),
      ],
      execute: async ({ prompt }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const description = String(prompt || '')
        const buf = await gen.generate(description)
        const data = buf.toString('base64')
        const visionAllowed = api.config().model?.vision !== 'off'
        const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + data } }], `[生图] ${description.slice(0, 30)}`)
        if (!sent) return { ok: false, message: '画好了，但没有发到 QQ（请检查试运行和网关）' }
        // 记的是提示词，不冒充实际画面描述；图片本身交给 DSH 登记为附件。
        try {
          memory.addEvent?.({ text: `按提示词画了一张图（不一定与实际画面一致）：${description.slice(0, 150)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        } catch (error) {
          api.log.warn('生图已发送，但经历没记下来：', error.message)
        }
        if (!visionAllowed) return { ok: true, message: '画好发出去了；当前设置为不看图，只能根据画图提示词说，别假装看到了实际画面。' }
        try {
          const attachments = api.dsh.attachments || api.dsh.get?.('attachments')
          if (!attachments?.admitPromptContent) throw new Error('宿主没有附件服务')
          const blocks = await attachments.admitPromptContent([{ type: 'image', data, mediaType: mimeOf(buf), name: 'aurabot-drawing' }])
          const image = blocks.find((block) => block.type === 'image' && block.attachment)
          if (!image) throw new Error('宿主没有返回图片附件')
          // 有视觉模型和记忆模块时，后台根据真正的图片生成一条画面描述，供以后新会话召回。
          // 不让额外的模型调用耽误工具返回；看不了图时只保留上面的提示词经历。
          if (api.config().memory?.enabled && memory.addEvent && typeof api.ask === 'function') {
            Promise.resolve().then(async () => {
              if ((await canSeeImages(api.dsh, api.config())) !== true) return
              const caption = String(await api.ask({
                system: '请只根据实际图片简短描述主体、场景和风格，不要猜测看不见的内容。看不到图片就回答「无法看图」。',
                text: '描述这张图片，不超过 100 字。', images: [{ data, mediaType: mimeOf(buf) }], maxTokens: 180, temperature: 0.2,
              }) || '').trim()
              if (caption && !/无法看图|看不到(图片|图像)|不能看图/.test(caption)) memory.addEvent?.({ text: `自己画过的图，实际画面：${caption.slice(0, 150)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
            }).catch((error) => api.log.warn('生图已发送，但画面描述没记下来：', error.message))
          }
          return { ok: true, message: '画好发出去了；这是实际发出的图片。', image }
        } catch (error) {
          api.log.warn('生图已发送，但没能交给模型看：', error.message)
          return { ok: true, message: '画好发出去了，但图片没能交给你看；只能根据画图提示词说，别假装看到了实际画面。' }
        }
      },
    }) : []))
    return gen
  },
}
