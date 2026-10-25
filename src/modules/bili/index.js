// 内置模块：B 站。别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人。

import { createBili } from '../../bili/duty.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.0.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论（bili_watch / bili_comment）',
  tab: 'bili',
  files: ['bili/duty.js', 'bili/api.js'],
  setup(api) {
    const { hub } = api.core
    const bili = createBili({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log })
    api.every(60_000, () => bili.tick(), '刷B站')

    // 看视频谁发的链接都能看，评论要主人开口
    api.tool(({ chat, sessionId }) => {
      if (!api.config().bili.enabled || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
        }),
      ]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
    return bili
  },
}
