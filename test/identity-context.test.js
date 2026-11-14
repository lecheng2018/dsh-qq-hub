// 身份中枢（阶段 0a）的回归网。
//
// 这个模块是「面板换卡后后台还念旧名字」的唯一出口，后台的记忆提炼、长期反思、
// 语感学习、目的引擎都只认它给的名字。它一旦错，错的不是一句话，而是沉淀进记忆库的
// 全部事实的口吻——所以这里把四条易错路径钉死：
//   ① 正则转义：人设名里可能有 . * + ? ( ) [ ] { } ^ $ | \ / 这些正则元字符；
//   ② 自称正则：纯 ASCII 名必须整词（角色名叫 A 时「AXBXC 家的猫」不是她）；
//   ③ chatKey 归一：对象视图回喂、带前缀的 groupId、裸号，都不能拼出 group:group:123；
//   ④ 兜底：读卡失败 / 没卡 / personaIdFor 抛错时不许抛，且名字与指代必须是同一份真相。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_CHARACTER_NAME,
  characterName,
  escapeRegExp,
  resolveCharacterIdentity,
  selfRefPattern,
} from '../src/persona/identity-context.js'

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

/** 记录身份中枢最终喂给 chatViewFromKey 的 chatKey；personaIdFor 给空 id（不读卡）。 */
function viewProbe() {
  const seen = []
  const deps = {
    chatViewFromKey: () => ({ kind: 'system', chatId: '', groupId: '', userId: '' }),
    personaIdFor: () => '',
    readPersona: () => null,
  }
  const run = (chat) => {
    deps.chatViewFromKey = (key) => {
      seen.push(key)
      return { kind: 'system', chatId: String(key), groupId: '', userId: '' }
    }
    resolveCharacterIdentity(chat, {}, deps)
    return seen.at(-1)
  }
  return run
}

// ---------- ① 正则转义 ----------

test('escapeRegExp：正则元字符都当字面量', () => {
  assert.equal(escapeRegExp('A.B*C+'), 'A\\.B\\*C\\+')
  assert.equal(escapeRegExp('a(b)[c]{d}'), 'a\\(b\\)\\[c\\]\\{d\\}')
  assert.equal(escapeRegExp('x|y^z$'), 'x\\|y\\^z\\$')
  assert.equal(escapeRegExp('路径/a\\b'), '路径\\/a\\\\b')
  assert.equal(escapeRegExp(undefined), '', '坏值不抛，退化成空串')
  assert.equal(escapeRegExp(42), '42')
})

// ---------- ② 自称正则 ----------

test('自称正则：纯 ASCII 名必须整词才算', () => {
  const re = selfRefPattern(['A'])
  assert.equal(re.test('我来了'), true, '「我」永远算她自己')
  assert.equal(re.test('A 你在吗'), true)
  assert.equal(re.test('a 你在吗'), true, '大小写不敏感')
  assert.equal(re.test('AXBXC家的猫'), false, '英文名不能当半个词匹配')
  assert.equal(re.test('abc'), false)
})

test('自称正则：中文名与带符号的名字按字面量匹配', () => {
  const cn = selfRefPattern(['大肥鱼', '肥鱼'])
  assert.equal(cn.test('大肥鱼在吗'), true)
  assert.equal(cn.test('肥鱼！'), true)
  assert.equal(cn.test('大白鱼在吗'), false)
  const weird = selfRefPattern(['A.B*C+'])
  assert.equal(weird.test('A.B*C+ 你好'), true, '名字里的元字符要当字面量')
  assert.equal(weird.test('AXBXC 你好'), false)
})

test('自称正则：没有名字时只认「我」，绝不匹配任何开头', () => {
  for (const bad of [[], [''], '  ', null, undefined]) {
    const re = selfRefPattern(bad)
    assert.equal(re.test('我'), true)
    assert.equal(re.test('小明喜欢吃辣'), false, '空名字退化成 `^(?:我|)` 会把所有条目当她自己，事实全丢')
  }
})

// ---------- ③ chatKey 归一 ----------

test('chatKey 归一：字符串入口原样走 chatViewFromKey', () => {
  const probe = viewProbe()
  assert.equal(probe('group:123'), 'group:123')
  assert.equal(probe('private:9'), 'private:9')
  assert.equal(probe(''), '')
})

test('chatKey 归一：对象视图回喂不重复拼前缀', () => {
  const probe = viewProbe()
  // 这五种是真实调用形态：chatViewFromKey 的输出（chatId 是全 key、groupId 是裸号）、
  // 调用方自己拼的带前缀 groupId、以及裸数字 id。
  assert.equal(probe({ kind: 'group', groupId: '123' }), 'group:123')
  assert.equal(probe({ kind: 'group', groupId: 'group:123' }), 'group:123', '不能拼成 group:group:123')
  assert.equal(probe({ kind: 'group', chatId: 'group:123' }), 'group:123')
  assert.equal(probe({ kind: 'group', chatId: 123 }), 'group:123', '裸号不能被 slice 切空')
  assert.equal(probe({ kind: 'private', userId: '9' }), 'private:9')
  assert.equal(probe({ kind: 'private', chatId: 'private:9' }), 'private:9')
  assert.equal(probe({ kind: 'private', chatId: 9 }), 'private:9')
  assert.equal(probe({ chatId: 'group:7' }), 'group:7', '没 kind 时仍交给 chatViewFromKey 判')
})

test('chatKey 归一后 personaIdFor 看到的是正确的 kind 与 id', () => {
  const views = []
  resolveCharacterIdentity(
    { kind: 'group', groupId: 'group:123' },
    { persona: { groups: { 123: 'card-x' } } },
    {
      personaIdFor: (chat) => { views.push(chat); return '' },
      readPersona: () => null,
      chatViewFromKey: () => ({ kind: 'group', chatId: 'group:123', groupId: '123', userId: '' }),
    },
  )
  assert.equal(views[0].kind, 'group')
  assert.equal(views[0].groupId, '123', '按群人设查的是裸群号')
})

// ---------- ④ 兜底与一致性 ----------

test('读卡抛错：不抛，退回默认名，且名字与指代是同一份真相', () => {
  const id = resolveCharacterIdentity('private:9', {}, {
    personaIdFor: () => 'card-x',
    readPersona: () => { throw new Error('卡片文件坏了') },
  })
  assert.equal(id.name, DEFAULT_CHARACTER_NAME)
  assert.equal(id.hasCard, false)
  assert.equal(id.shortBio, `「${DEFAULT_CHARACTER_NAME}」`, '名字和指代不能再一处一个说法')
  assert.equal(id.wakeWords[0], DEFAULT_CHARACTER_NAME)
  assert.equal(id.id, 'card-x', 'id 仍然保留，方便上层判断「本该有卡」')
})

test('没卡（null）：同样退回默认名，不抛', () => {
  const id = resolveCharacterIdentity('private:9', {}, { personaIdFor: () => 'card-x', readPersona: () => null })
  assert.equal(id.name, DEFAULT_CHARACTER_NAME)
  assert.equal(id.hasCard, false)
  assert.equal(id.rolePrompt, '')
})

test('personaIdFor 抛错：整条链路不抛', () => {
  const id = resolveCharacterIdentity('group:1', {}, {
    personaIdFor: () => { throw new Error('配置读不到') },
    readPersona: () => ({ name: '不该被读到' }),
  })
  assert.equal(id.name, DEFAULT_CHARACTER_NAME)
  assert.equal(id.hasCard, false)
})

test('有卡：名字、自称正则、指代、正文都来自那张卡', () => {
  const id = resolveCharacterIdentity('private:9', {}, {
    personaIdFor: () => 'card-x',
    readPersona: () => ({ name: '小鲸', body: '你是小鲸，住在 QQ 里。' }),
  })
  assert.equal(id.name, '小鲸')
  assert.equal(id.hasCard, true)
  assert.equal(id.shortBio, '「小鲸」')
  assert.equal(id.rolePrompt, '你是小鲸，住在 QQ 里。')
  assert.equal(id.selfRefRegex.test('小鲸在吗'), true)
  assert.equal(id.selfRefRegex.test('我到了'), true)
  assert.equal(id.selfRefRegex.test('小鲤鱼在吗'), false)
})

test('唤醒词：卡名在前，cfg.group.wakeWords 兼容数组与分隔字符串', () => {
  const deps = { personaIdFor: () => 'card-x', readPersona: () => ({ name: '小鲸' }) }
  const arr = resolveCharacterIdentity('group:1', { group: { wakeWords: ['肥鱼', ' 小鲸 '] } }, deps)
  assert.deepEqual(arr.wakeWords, ['小鲸', '肥鱼'], '去重后卡名在第一位')
  const str = resolveCharacterIdentity('group:1', { group: { wakeWords: '肥鱼， 泡泡鲸  小鲸' } }, deps)
  assert.deepEqual(str.wakeWords, ['小鲸', '肥鱼', '泡泡鲸'])
  const none = resolveCharacterIdentity('group:1', {}, deps)
  assert.deepEqual(none.wakeWords, ['小鲸'])
})

test('characterName：只要名字的快捷方式', () => {
  const deps = { personaIdFor: () => 'card-x', readPersona: () => ({ name: '小鲸' }) }
  assert.equal(characterName('group:1', {}, deps), '小鲸')
  assert.equal(characterName('', { persona: { current: '' } }, { personaIdFor: () => '', readPersona: () => null }), DEFAULT_CHARACTER_NAME)
})

// ---------- 循环依赖护栏 ----------

test('默认名住在零 import 的叶子模块里，personas 与 identity-context 不再互引', () => {
  const defaults = src('src/persona/identity-defaults.js')
  assert.equal(/^\s*import\s/m.test(defaults), false, 'identity-defaults 不许 import 任何东西，否则环又回来了')
  assert.match(defaults, /DEFAULT_CHARACTER_NAME/)
  assert.doesNotMatch(src('src/persona/personas.js'), /from '\.\/identity-context\.js'/, 'personas 不许再引 identity-context')
  assert.match(src('src/persona/personas.js'), /from '\.\/identity-defaults\.js'/)
})
