// QQ Hub · 面板路由：日志 / 本地脚本 / 头像 / 联动开放接口 / 模型（host.js 分层拆出）

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileOf, toImageBuffer } from '../../local/local.js'
import { mimeOf } from '../../chat/inbound.js'
import { askModel, clearReasoningCache, clearVisionCache } from '../../core/llm.js'
import { dataDir, ensureDir } from '../../core/store.js'

export function registerMiscRoutes({
  route, readBody, query, send,
  ctx, getConfig,
  logger, local, onebot, hub, bridge,
  models, openFolder,
  avatarPath, avatarInfo,
  root, log,
}) {
  route('/logs', async (req) => {
    const q = query(req)
    return { ok: true, entries: logger.recent(Number(q.limit) || 300, { level: q.level || '', area: q.area || '' }) }
  })

  // 本地接口
  route('/local/status', async () => ({ ok: true, dir: local.dir(), list: local.status() }))
  route('/local/template', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    if (!local.pathOf || !['tts', 'image', 'song', 'asr'].includes(slot)) return { ok: false, message: '没有这一项' }
    return local.template(slot)
  })
  route('/local/open', async () => openFolder(local.dir()))
  route('/local/test', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    try {
      if (slot === 'tts') {
        const file = fileOf(await local.call('tts', { text: '你好呀，我是大肥鱼，这是本地语音测试。' }))
        if (!file || !existsSync(file)) return { ok: false, message: '脚本没返回音频文件' }
        return { ok: true, message: `念好了：${file}` }
      }
      if (slot === 'image') {
        const buf = await toImageBuffer(await local.call('image', { prompt: '一条胖乎乎的蓝色小鱼，可爱，插画', size: getConfig().imageGen.size || '1024x1024' }))
        return { ok: true, message: `画好了（${Math.round(buf.length / 1024)} KB）`, image: buf.toString('base64') }
      }
      return { ok: false, message: '这一项没法单独试：翻唱换声去 QQ 里点首歌，语音识别发条语音条试试' }
    } catch (error) {
      return { ok: false, message: '出错了：' + error.message }
    }
  })

  // 联动密钥只显示配置状态，不通过面板 API 回显、生成或重置
  route('/bridge/token', async () => ({ ok: true, configured: Boolean(getConfig().bridge.token) }))
  route('/bridge/token/reset', async () => ({ ok: false, message: '联动密钥不能通过面板 API 重置，请在本机配置文件中修改' }))
  route('/bridge/examples', async (req) => {
    const base = String(query(req).base || 'http://127.0.0.1:端口')
    const examples = bridge.examples(base)
    const token = getConfig().bridge.token
    if (!token) return { ok: true, ...examples }
    return JSON.parse(JSON.stringify(examples).replaceAll(token, '<密钥>'))
  })
  // 开放接口：都要带密钥
  const open = (path, fn) => route('/open' + path, async (req) => {
    if (!bridge.authorized(req)) return { ok: false, code: 401, message: getConfig().bridge.http ? '密钥不对（请求头 Authorization: Bearer 密钥）' : '开放接口没打开（面板「扩展」→ 联动）' }
    return fn(req)
  })
  open('/info', async () => bridge.ops.info())
  open('/send', async (req) => bridge.ops.send(await readBody(req)))
  open('/think', async (req) => bridge.ops.think(await readBody(req)))
  open('/call', async (req) => bridge.ops.call(await readBody(req)))
  open('/events', async (req) => bridge.ops.events(query(req)))

  // 模型：列出 DSH 里可用的模型，测一下哪个回得快
  route('/models/apply', async () => {
    try {
      const r = await hub.syncAllModels()
      if (r.applied) log.info(`[模型] 按面板配置切换了 ${r.applied} 个会话`)
      // 消息要如实反映：有失败就说失败，别在失败时还说「都和配置一致」
      const parts = []
      if (r.applied) parts.push(`切换了 ${r.applied} 个会话`)
      if (r.failed) parts.push(`${r.failed} 个切不了（会话可能已失效，发条消息让它重建）`)
      if (!r.applied && !r.failed) parts.push(`没有需要切的会话（都和配置一致）`)
      return { ok: r.failed === 0, ...r, message: parts.join('；') }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })

  route('/models', async (req) => {
    try {
      if (new URL(req.url, 'http://x').searchParams.get('refresh') === '1') { clearReasoningCache(); clearVisionCache() }
      return { ok: true, list: await models.listModels() }
    } catch (error) {
      return { ok: false, message: error.message, list: [] }
    }
  })
  route('/model/ping', async (req) => {
    const b = await readBody(req)
    const t = Date.now()
    try {
      const text = await askModel(ctx, { cfg: { model: { provider: b.provider, model: b.model } }, system: '只回复两个字：在呢', text: '在吗', maxTokens: 800 })
      return { ok: true, ms: Date.now() - t, text: text.slice(0, 40) }
    } catch (error) {
      return { ok: false, ms: Date.now() - t, message: error.message }
    }
  })

  // 形象图
  route('/avatar', async (req, res) => {
    if (existsSync(avatarPath())) {
      const buf = readFileSync(avatarPath())
      return send(res, 200, buf, mimeOf(buf))
    }
    const p = join(root, 'assets', 'dafeiyu.jpg')
    if (!existsSync(p)) return send(res, 404, '')
    send(res, 200, readFileSync(p), 'image/jpeg')
  })
  route('/avatar/upload', async (req) => {
    const b = await readBody(req)
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
    if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大（最多 5MB）或是空的' }
    if (!mimeOf(buf).startsWith('image/')) return { ok: false, message: '只支持 PNG、JPG、GIF、WebP 图片' }
    ensureDir(dataDir())
    writeFileSync(avatarPath(), buf)
    log.info('换了面板头像')
    return { ok: true, message: '头像换好了', avatar: avatarInfo() }
  })
  route('/avatar/reset', async () => {
    try { unlinkSync(avatarPath()) } catch (error) {}
    return { ok: true, message: '恢复成默认头像了', avatar: avatarInfo() }
  })
  route('/avatar/sync-qq', async () => {
    const buf = existsSync(avatarPath()) ? readFileSync(avatarPath()) : readFileSync(join(root, 'assets', 'dafeiyu.jpg'))
    try {
      await onebot.call('set_qq_avatar', { file: 'base64://' + buf.toString('base64') })
      return { ok: true, message: '已经设成机器人号的 QQ 头像' }
    } catch (error) {
      return { ok: false, message: 'QQ 头像没换成：' + error.message }
    }
  })
}
