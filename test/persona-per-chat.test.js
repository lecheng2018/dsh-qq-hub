import test from 'node:test'
import assert from 'node:assert/strict'
import { personaIdFor } from '../src/persona/personas.js'

test('personaIdFor：群聊和私聊分别匹配专属卡，未指定的走各自默认或全局', () => {
  const cfg = {
    persona: {
      current: 'persona-global',
      groupDefault: 'persona-group-def',
      privateDefault: 'persona-priv-def',
      privates: {
        '10001': 'persona-special-owner',
      },
      groups: {
        '777': 'persona-special-group',
      },
    },
  }

  // 1. 指定了群专属卡的群 -> 专属卡
  assert.equal(personaIdFor({ kind: 'group', groupId: '777' }, cfg), 'persona-special-group')
  // 2. 未指定专属卡的群 -> 群默认卡
  assert.equal(personaIdFor({ kind: 'group', groupId: '888' }, cfg), 'persona-group-def')
  // 3. 指定了私聊专属卡的用户 -> 私聊专属卡
  assert.equal(personaIdFor({ kind: 'private', userId: '10001' }, cfg), 'persona-special-owner')
  // 4. 未指定专属卡的私聊用户 -> 私聊默认卡
  assert.equal(personaIdFor({ kind: 'private', userId: '10002' }, cfg), 'persona-priv-def')
  // 5. 没有群默认卡时 -> 回落到全局卡
  const noGroupDef = { persona: { current: 'persona-global', privates: {}, groups: {} } }
  assert.equal(personaIdFor({ kind: 'group', groupId: '999' }, noGroupDef), 'persona-global')
})

test('按会话解析人设变量：通过 context.agent.session.id 反查群聊/私聊专属人设', () => {
  const cfg = {
    persona: {
      current: 'global-card',
      groupDefault: 'group-doubao',
      privateDefault: 'global-card',
      privates: {},
      groups: {
        '666777888': 'group-doubao',
      },
    },
  }

  const personas = {
    'global-card': { id: 'global-card', name: '小鲸鱼', body: '【人设】你是小鲸鱼，说话简短温柔。' },
    'group-doubao': { id: 'group-doubao', name: '豆包', body: '【人设】你是豆包，毒舌技术宅。' },
  }

  const sessionToChat = new Map([
    ['sess-group-1', 'group:666777888'],
    ['sess-private-1', 'private:900000004'],
  ])

  // 模拟 host.js 中的 resolvePersonaForContext 核心逻辑
  function resolvePersonaForContext(context) {
    try {
      const sid = context?.agent?.session?.id || context?.session?.id || context?.sessionId
      if (sid && sessionToChat.has(sid)) {
        const chatKey = sessionToChat.get(sid)
        const parts = String(chatKey).split(':')
        const chat = parts[0] === 'group'
          ? { kind: 'group', groupId: parts[1], chatId: chatKey }
          : { kind: 'private', userId: parts[1], chatId: chatKey }
        const want = personaIdFor(chat, cfg)
        if (want && personas[want]?.body) {
          return personas[want].body
        }
      }
    } catch {}
    return personas[cfg.persona.current]?.body || ''
  }

  // 模拟 DSH 组装系统提示词时传入的 context
  const groupContext = { agent: { session: { id: 'sess-group-1' } } }
  const privateContext = { agent: { session: { id: 'sess-private-1' } } }
  const unknownContext = { agent: { session: { id: 'sess-unknown' } } }
  const emptyContext = {}

  // 验证：群聊拿到了豆包卡，私聊拿到了小鲸鱼卡，未知会话安全回退全局卡
  assert.match(resolvePersonaForContext(groupContext), /你是豆包/)
  assert.match(resolvePersonaForContext(privateContext), /你是小鲸鱼/)
  assert.match(resolvePersonaForContext(unknownContext), /你是小鲸鱼/)
  assert.match(resolvePersonaForContext(emptyContext), /你是小鲸鱼/)
})
