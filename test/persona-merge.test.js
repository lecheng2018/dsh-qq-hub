import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, mergeFromPanel } from '../src/core/config.js'

test('mergeFromPanel：面板删掉人设分流中的群或私聊，保存后不会被 deepMerge 恢复（解决「03删不掉、删除保存又出现」）', () => {
  // 服务端现有配置：包含历史遗留的 '03' 和两个群
  const cur = normalize({
    persona: {
      current: 'dafeiyu',
      groupDefault: '',
      privateDefault: '',
      privates: { '10001': 'dafeiyu' },
      groups: {
        '03': '',
        '249729644': 'dafeiyu',
        '615693464': 'dafeiyu',
      },
    },
  })

  assert.equal(cur.persona.groups['03'], '', '前置：配置中原本有 03')
  assert.equal(cur.persona.groups['249729644'], 'dafeiyu', '前置：配置中原本有 249729644')

  // 用户在面板中点击 [删] 删掉了 '03' 和 '249729644'，只保留 '615693464'
  const incoming = {
    persona: {
      current: 'dafeiyu',
      groupDefault: '',
      privateDefault: '',
      privates: { '10001': 'dafeiyu' },
      groups: {
        '615693464': 'dafeiyu',
      },
    },
  }

  const saved = mergeFromPanel(cur, incoming)

  assert.equal(saved.persona.groups['615693464'], 'dafeiyu', '保留的群应当存在')
  assert.equal(saved.persona.groups['03'], undefined, '已删除的 03 绝不能在保存后又出现')
  assert.equal(saved.persona.groups['249729644'], undefined, '已删除的群 249729644 绝不能在保存后又出现')
  assert.deepEqual(Object.keys(saved.persona.groups), ['615693464'])
})

test('mergeFromPanel：清空全部按群换人设或私聊人设（传空对象 {}）时，整张表清空', () => {
  const cur = normalize({
    persona: {
      current: 'dafeiyu',
      groups: { '615693464': 'dafeiyu' },
      privates: { '10001': 'dafeiyu' },
    },
  })

  const incoming = {
    persona: {
      current: 'dafeiyu',
      groups: {},
      privates: {},
    },
  }

  const saved = mergeFromPanel(cur, incoming)
  assert.deepEqual(saved.persona.groups, {})
  assert.deepEqual(saved.persona.privates, {})
})

test('normalizePersona：以 # 开头的临时占位行（如 #new...）绝不落盘被洗成纯数字（根因预防）', () => {
  const raw = {
    persona: {
      current: 'dafeiyu',
      groups: {
        '#newm5k03ab': '',
        '#new99xyz': 'dafeiyu',
        '1124211723': 'dafeiyu',
      },
      privates: {},
    },
  }

  const c = normalize(raw)
  // 以前会把 #newm5k03ab 洗成 '03'，把 #new99xyz 洗成 '99'
  assert.equal(c.persona.groups['03'], undefined, '占位行不得被洗成数字 03')
  assert.equal(c.persona.groups['99'], undefined, '占位行不得被洗成数字 99')
  assert.equal(c.persona.groups['1124211723'], 'dafeiyu', '合法群号正常保留')
  assert.deepEqual(Object.keys(c.persona.groups), ['1124211723'])
})
