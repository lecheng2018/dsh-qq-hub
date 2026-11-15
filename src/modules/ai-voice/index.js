// 内置模块：AI 语音。QQ 官方 AI 变声（send_group_ai_record）——零成本的云端 TTS 备选，免自建。
//
// 边界（如实）：
//   · 只做群聊（send_group_ai_record 是群动作）；私聊不发 AI 语音；
//   · 刻意**不接进自动语音链**（voice 模块的 speak 返回文件，AI 变声是服务端直接发送、没有文件），
//     入口是 /变声 主人命令——想让她平时说话用它，等协议端暴露出文件级导出再说；
//   · 角色列表 get_ai_characters 拉一次缓存 10 分钟（有界单条缓存，不无限攒）。
//
// send_ 前缀动作：api.onebot 自动转进统一 Outbox（台账/dryRun 生效）。

import { defineTool, str } from '../../tools/tools.js'
import { registerReadActions } from '../../onebot/read-actions.js'

/** 角色列表缓存 TTL。 */
const CHARACTER_TTL_MS = 10 * 60_000

/** 从任意返回形状抽角色 [{id, name}]（防御式：字段漂移免疫）。 */
export function extractCharacters(result) {
  const candidates = []
  if (Array.isArray(result)) candidates.push(result)
  else if (result && typeof result === 'object') {
    for (const key of ['characters', 'list', 'items', 'data']) {
      if (Array.isArray(result[key])) candidates.push(result[key])
      else if (result[key] && typeof result[key] === 'object' && Array.isArray(result[key].characters)) candidates.push(result[key].characters)
    }
  }
  const arr = candidates.find((a) => a.length > 0) || []
  return arr.map((it) => {
    const o = (it && typeof it === 'object') ? it : {}
    return {
      id: String(o.character_id ?? o.characterId ?? o.id ?? o.character ?? '').trim(),
      name: String(o.character_name ?? o.characterName ?? o.name ?? o.nick ?? '').trim(),
    }
  }).filter((x) => x.id)
}

/** 按名称或 id 在角色列表里挑（精确 id > 精确名 > 包含名；认不出返回 null）。 */
export function pickCharacter(characters, query) {
  const q = String(query ?? '').trim()
  if (!q || !Array.isArray(characters) || !characters.length) return null
  const byId = characters.find((c) => c.id === q)
  if (byId) return byId
  const byName = characters.find((c) => c.name === q)
  if (byName) return byName
  const contains = characters.find((c) => c.name && (c.name.includes(q) || q.includes(c.name)))
  return contains || null
}

export default {
  id: 'ai-voice',
  name: 'AI 语音',
  version: '1.0.0',
  description: 'QQ 官方 AI 变声（/变声 主人命令，群聊专用）：零成本云端 TTS 备选；不接自动语音链，只做命令触发',
  tab: 'voice',
  defaults: {
    character: '',
  },
  settings: [
    { key: 'character', label: '默认角色', type: 'text', placeholder: '角色 id 或名字', hint: '/变声 不带角色名时用这个；角色列表看面板「语音」页的 AI 语音接口（/ai-voice/characters）' },
  ],
  setup(api) {
    const { onebot } = api.core

    const reg = registerReadActions(['get_ai_characters'])
    if (reg.rejected.length) api.log.warn(`只读动作登记被拒收：${reg.rejected.join('、')}`)

    /** 角色列表：单条缓存（TTL 10 分钟），失败返回空列表并如实报错给调用方。 */
    let cache = null // { at, list }
    async function characters() {
      if (cache && Date.now() - cache.at < CHARACTER_TTL_MS) return cache.list
      const raw = await onebot.call('get_ai_characters', {}, { timeoutMs: 10000 })
      const list = extractCharacters(raw)
      if (list.length) cache = { at: Date.now(), list }
      return list
    }

    /** 按查询挑角色：给了 query 就从列表挑，没给就用默认设置；都拿不到抛人话错误。 */
    async function resolveCharacter(query) {
      const q = String(query ?? '').trim() || String(api.settings().character ?? '').trim()
      if (!q) throw new Error('没指定角色：/变声 <角色名或id> <文字>，或先在设置里填默认角色')
      const list = await characters()
      const pick = pickCharacter(list, q)
      if (!pick) {
        if (!list.length) throw new Error('网关没给角色列表（get_ai_characters 空的），暂时变不了声')
        throw new Error(`没有叫「${q}」的角色。有的：${list.slice(0, 10).map((c) => `${c.name}(${c.id})`).join('、')}`)
      }
      return pick
    }

    // 主人工具（私聊也能让她去群里发——发的是群语音，target 必须是白名单群）
    api.tool(({ chat, level, sessionId }) => {
      if (level !== 'full') return []
      return defineTool({
        name: 'qq_ai_record',
        description: '用 QQ 官方 AI 变声在群里发一条语音（不用本地 TTS）。target 写 group:群号（必须在白名单里）；character 可选，省略用默认角色。只有主人要求时才用。',
        properties: {
          text: str('要说的话'),
          character: str('角色名或 id，省略用默认'),
          target: str('group:群号；省略 = 当前聊天（当前不是群就必须要给）'),
        },
        required: ['text'],
        execute: async (args) => {
          if (!api.core.hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我用 AI 语音' }
          const cfg = api.config()
          const gidRaw = String(args.target || '').replace(/^group:/, '').trim() || (chat.kind === 'group' ? String(chat.groupId) : '')
          if (!gidRaw || !/^\d+$/.test(gidRaw)) return { ok: false, message: 'AI 语音只能发群聊：target 写 group:群号' }
          if (!cfg.allow.groups.includes(gidRaw)) return { ok: false, message: '这个群不在白名单里，不能发' }
          const pick = await resolveCharacter(args.character)
          const text = String(args.text || '').trim()
          if (!text) return { ok: false, message: '要给 text（要说的话）' }
          // send_ 前缀：自动进统一 Outbox（台账/dryRun 生效；被拦下返回空如实回报）
          const r = await api.onebot('send_group_ai_record', { group_id: Number(gidRaw), character: pick.id, text }, { timeoutMs: 30000 })
          if (!r) return { ok: false, message: '没发出去（被试运行/总开关/出站闸拦下），台账已记' }
          return { ok: true, message: `AI 语音发出去了（角色：${pick.name || pick.id}）` }
        },
      })
    })

    // 主人命令：/变声 [角色] <文字>（当前群；私聊提示不支持）
    api.command({
      name: '变声',
      desc: '用 QQ 官方 AI 变声在当前群发一条语音',
      run: async (arg, msg) => {
        if (msg?.kind !== 'group') return 'AI 语音只能发群聊（协议就是群动作），私聊不支持。'
        const parts = String(arg || '').trim()
        if (!parts) return '用法：/变声 <角色名或id> <要说的话>；不带角色就用设置里的默认角色。'
        const idx = parts.indexOf(' ')
        const character = idx > 0 ? parts.slice(0, idx).trim() : ''
        const text = idx > 0 ? parts.slice(idx + 1).trim() : parts
        if (!text) return '要给要说的话：/变声 <角色名或id> <文字>'
        try {
          const pick = await resolveCharacter(character)
          const r = await api.onebot('send_group_ai_record', { group_id: Number(msg.groupId), character: pick.id, text }, { timeoutMs: 30000 })
          if (!r) return '没发出去（被试运行/总开关/出站闸拦下），台账已记。'
          return `AI 语音发出去了（角色：${pick.name || pick.id}）`
        } catch (error) {
          return `没发成：${String(error?.message || error).slice(0, 150)}`
        }
      },
    })

    // 角色列表接口（面板「语音」页提示用）
    api.route('/ai-voice/characters', async () => {
      try {
        const list = await characters()
        return { ok: true, list }
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    })

    return { extractCharacters, pickCharacter, resolveCharacter }
  },
}
