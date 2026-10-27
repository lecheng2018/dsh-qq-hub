// 内置模块：刷抖音。专用 Edge + CDP 刷推荐流；点赞 / 评论 / 回评论 / 关注 / 私信 / 分享给主人 / 回主人私信。
// 8 项操作各自一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。总开关默认关，先登录再开。

import { createDouyin } from '../../douyin/duty.js'
import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'
import { parseUserInput } from '../../douyin/util.js'

export default {
  id: 'douyin',
  name: '刷抖音',
  version: '1.0.0',
  description: '用专用 Edge 刷抖音：看推荐、点赞、评论、关注、私信、分享给主人、回主人私信（douyin_watch / douyin_dm）',
  tab: 'douyin',
  files: ['douyin/duty.js', 'douyin/cdp.js', 'douyin/util.js'],
  setup(api) {
    const { hub, http } = api.core

    const dy = createDouyin({
      getConfig: api.config,
      hub,
      memory: api.lazy('memory'),
      log: api.log,
    })

    // confirmOwner 要能写入 owner.secUid（面板保存时会被挡掉，只能走这条路由）
    const originalConfirm = dy.confirmOwner
    dy.confirmOwner = async (input) => {
      const raw = String(input ?? api.config().douyin?.owner?.input ?? '').trim()
      const parsed = parseUserInput(raw)
      if (!parsed) return { ok: false, message: '请填抖音号，或主页链接（douyin.com/user/…）' }
      // 临时挂写入钩子给 duty
      api.config._setOwner = (owner) => {
        api.setConfig((cur) => ({
          ...cur,
          douyin: { ...cur.douyin, owner: { ...cur.douyin.owner, ...owner } },
        }))
      }
      try {
        return await originalConfirm(raw)
      } finally {
        delete api.config._setOwner
      }
    }

    api.every(60_000, () => dy.tick(), '刷抖音')

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      if (!cfg.douyin.enabled) return { ok: false, message: '抖音没打开' }
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    // 看视频 / 私信：按对应权限挂工具
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.douyin.enabled || chat.kind === 'system') return []
      const tools = []
      if (profileToolVisible(cfg, 'douyinBrowse', chat)) tools.push(defineTool({
        name: 'douyin_watch',
        description: '打开一个抖音视频看看：读文案和热评。别人发来抖音链接时用。link 填视频链接。',
        properties: { link: str('抖音视频链接或 v.douyin.com 短链') },
        required: ['link'],
        execute: guarded('douyinBrowse', chat, sessionId, async ({ link }) => dy.watch(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinDm', chat)) tools.push(defineTool({
        name: 'douyin_dm',
        description: '给某个抖音用户发私信。target 填对方主页链接或 sec_uid，text 是私信内容。建议用小号。只有别人明确让你发时才用。',
        properties: { target: str('对方主页链接或 sec_uid'), text: str('私信内容') },
        required: ['target', 'text'],
        execute: guarded('douyinDm', chat, sessionId, async ({ target, text }) => dy.dmTo(String(target || ''), String(text || ''))),
      }))
      return tools
    })

    api.route('/douyin/state', async () => ({ ok: true, ...dy.state(), account: await dy.account() }))
    api.route('/douyin/account', async () => dy.account(true))
    api.route('/douyin/run', async () => dy.run({ force: true }))
    api.route('/douyin/dms', async () => dy.checkOwnerDms())
    api.route('/douyin/replies', async () => dy.checkCommentReplies())
    api.route('/douyin/confirm-owner', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const input = b?.input ?? api.config().douyin?.owner?.input ?? ''
      return dy.confirmOwner(input)
    })
    api.route('/douyin/open-login', async () => {
      // 只负责把浏览器拉起来让主人扫码；不改 enabled
      const r = await dy.account(true)
      return { ok: !r.error, message: r.needLogin ? '已打开抖音，请在弹出的 Edge 窗口里扫码登录' : (r.isLogin ? `已登录：${r.nickname || r.secUid}` : (r.reason || r.error || '请看 Edge 窗口')), ...r }
    })

    return dy
  },
}
