// 按聊天换人设：优先级必须和 chatModels 一致，且没配时行为完全不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { personaIdFor } = await import(`file:///${REPO}/src/persona/personas.js`)

const cfg = (p) => ({ persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {}, ...p } })

test('没配任何分流：私聊群聊都走全局人设', () => {
  const c = cfg({})
  assert.equal(personaIdFor({ kind: 'private', userId: '2471784685' }, c), 'dafeiyu')
  assert.equal(personaIdFor({ kind: 'group', groupId: '1124211723' }, c), 'dafeiyu')
})

test('群默认生效，但具体群号优先于群默认', () => {
  const c = cfg({ groupDefault: 'grp-default', groups: { '1124211723': 'special-group' } })
  assert.equal(personaIdFor({ kind: 'group', groupId: '999' }, c), 'grp-default', '没指定的群用群默认')
  assert.equal(personaIdFor({ kind: 'group', groupId: '1124211723' }, c), 'special-group', '具体群号优先级更高')
})

test('私聊默认生效，但具体 QQ 号优先', () => {
  const c = cfg({ privateDefault: 'priv-default', privates: { '2471784685': 'owner-persona' } })
  assert.equal(personaIdFor({ kind: 'private', userId: '123456' }, c), 'priv-default')
  assert.equal(personaIdFor({ kind: 'private', userId: '2471784685' }, c), 'owner-persona')
})

test('群和私聊互不影响：群配置不会串到私聊', () => {
  const c = cfg({ groupDefault: 'grp', privates: { '111': 'p1' } })
  assert.equal(personaIdFor({ kind: 'private', userId: '222' }, c), 'dafeiyu', '私聊没配就回全局')
  assert.equal(personaIdFor({ kind: 'group', groupId: '333' }, c), 'grp')
})

test('空串视为没指定，继续往下落', () => {
  const c = cfg({ groups: { '1124211723': '' }, groupDefault: 'grp-default' })
  assert.equal(personaIdFor({ kind: 'group', groupId: '1124211723' }, c), 'grp-default', '空串要落回群默认')
})

test('老配置形状（无分流字段）不会崩', () => {
  assert.equal(personaIdFor({ kind: 'group', groupId: '1' }, { persona: { current: 'x' } }), 'x')
  assert.equal(personaIdFor({ kind: 'private', userId: '1' }, {}), 'dafeiyu', 'cfg 为空也要给人设')
})

test('system 会话只走全局', () => {
  const c = cfg({ groupDefault: 'grp' })
  assert.equal(personaIdFor({ kind: 'system' }, c), 'dafeiyu')
})
