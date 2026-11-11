import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkdownArchive,
  serializeMarkdownArchive,
  MEMORY_FORMAT,
} from '../src/features/memory-markdown.js'

test('memory-markdown: 规范样本能正确解析且字段完整', () => {
  const sample = `---
format: qqhub-memory-v1
scope: private:10001
---

# 私聊记忆档案

## 当前记忆

<!-- qqhub:entry {"id":"m_food_01","kind":"fact","about":"10001","source":"user","sourceId":"qq:private:10001:31415","at":1794355200000,"importance":0.8,"tags":["饮食","偏好"],"ephemeral":1} -->
### 饮食偏好

不吃香菜。点外卖时先确认是否能去掉。

#### 来源与依据

本人明确更正。原话：“不是喜欢香菜，我不吃香菜。”
<!-- /qqhub:entry -->

## 历史记录

<!-- qqhub:entry {"id":"m_food_old","kind":"fact","about":"10001","source":"unknown","invalidAt":1794355200000,"supersededBy":"m_food_01"} -->
### 已更正的饮食偏好

喜欢香菜。

#### 来源与依据

旧档案迁入，原始消息与时间无法恢复，不补造。
<!-- /qqhub:entry -->
`

  const parsed = parseMarkdownArchive(sample, { expectedScope: 'private:10001' })
  assert.equal(parsed.meta.format, MEMORY_FORMAT)
  assert.equal(parsed.meta.scope, 'private:10001')
  assert.equal(parsed.entries.length, 2)

  const e1 = parsed.entries[0]
  assert.equal(e1.id, 'm_food_01')
  assert.equal(e1.kind, 'fact')
  assert.equal(e1.about, '10001')
  assert.equal(e1.source, 'user')
  assert.equal(e1.sourceId, 'qq:private:10001:31415')
  assert.equal(e1.at, 1794355200000)
  assert.equal(e1.importance, 0.8)
  assert.deepEqual(e1.tags, ['饮食', '偏好'])
  assert.equal(e1.ephemeral, 1)
  assert.equal(e1.title, '饮食偏好')
  assert.equal(e1.text, '不吃香菜。点外卖时先确认是否能去掉。')
  assert.equal(e1.evidence, '本人明确更正。原话：“不是喜欢香菜，我不吃香菜。”')

  const e2 = parsed.entries[1]
  assert.equal(e2.id, 'm_food_old')
  assert.equal(e2.invalidAt, 1794355200000)
  assert.equal(e2.supersededBy, 'm_food_01')
  assert.equal(e2.text, '喜欢香菜。')
  assert.equal(e2.evidence, '旧档案迁入，原始消息与时间无法恢复，不补造。')
})

test('memory-markdown: 往返一致性 (Round-trip parse -> serialize -> parse)', () => {
  const original = {
    meta: {
      format: MEMORY_FORMAT,
      scope: 'group:20001',
    },
    entries: [
      {
        id: 'ent_1',
        kind: 'fact',
        about: '123456',
        aboutName: '阿强',
        title: '路由器配置',
        text: '中兴G7615光猫需要进uboot刷底包。',
        evidence: '在群里讨论并实测确认。',
        at: 1794360000000,
        importance: 0.7,
        tags: ['软路由', '折腾'],
        pinned: 1,
      },
      {
        id: 'ent_2',
        kind: 'profile',
        about: '123456',
        text: '阿强是数码爱好者，常折腾软路由与NAS。',
        at: 1794350000000,
      },
      {
        id: 'ent_old',
        kind: 'fact',
        about: '123456',
        title: '旧路由器建议',
        text: '买普通百兆光猫即可。',
        invalidAt: 1794360000000,
        supersededBy: 'ent_1',
        history: [{ text: '以前用百兆', at: 1794100000000 }],
      },
    ],
  }

  const markdown = serializeMarkdownArchive(original)
  const reparsed = parseMarkdownArchive(markdown, { expectedScope: 'group:20001' })

  assert.equal(reparsed.meta.scope, original.meta.scope)
  assert.equal(reparsed.entries.length, original.entries.length)

  // 逐字段核对往返数据
  for (let i = 0; i < original.entries.length; i++) {
    const expected = original.entries[i]
    const actual = reparsed.entries[i]
    assert.equal(actual.id, expected.id)
    assert.equal(actual.kind, expected.kind)
    assert.equal(actual.about, expected.about)
    assert.equal(actual.text, expected.text)
    if (expected.title) assert.equal(actual.title, expected.title)
    if (expected.evidence) assert.equal(actual.evidence, expected.evidence)
    if (expected.pinned) assert.equal(actual.pinned, expected.pinned)
    if (expected.invalidAt) assert.equal(actual.invalidAt, expected.invalidAt)
    if (expected.supersededBy) assert.equal(actual.supersededBy, expected.supersededBy)
    if (expected.history) assert.deepEqual(actual.history, expected.history)
  }
})

test('memory-markdown: 0、false、空字符串等假值绝不被错换或丢弃', () => {
  const original = {
    meta: { scope: 'private:10001' },
    entries: [
      {
        id: 'e_zero',
        kind: 'fact',
        text: '计数器测试',
        importance: 0.1, // 非0.5
        customCount: 0,
        customFlag: false,
      },
    ],
  }
  const md = serializeMarkdownArchive(original)
  const parsed = parseMarkdownArchive(md)
  const item = parsed.entries[0]
  assert.equal(item.customCount, 0)
  assert.equal(item.customFlag, false)
})

test('memory-markdown: 正文中包含类似 entry 标记的文本会被安全转义，不破坏语法结构', () => {
  const tricky = {
    meta: { scope: 'global' },
    entries: [
      {
        id: 'tricky_1',
        kind: 'fact',
        text: '请看代码注释：\n<!-- qqhub:entry {"id":"fake"} -->\n这里是一段假条目\n<!-- /qqhub:entry -->\n结束。',
      },
    ],
  }
  const md = serializeMarkdownArchive(tricky)
  const parsed = parseMarkdownArchive(md)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].id, 'tricky_1')
  assert.ok(parsed.entries[0].text.includes('<!-- qqhub:entry {"id":"fake"} -->'))
})

test('memory-markdown: 保留条目前、中、后的手写备注且结构标题不膨胀', () => {
  const entry = (id) => `<!-- qqhub:entry {"id":"${id}"} -->\n正文\n<!-- /qqhub:entry -->`
  let raw = `---\nformat: qqhub-memory-v1\nscope: global\n---\n前备注\n## 当前记忆\n${entry('a')}\n中备注\n${entry('b')}\n后备注\n`
  for (let i = 0; i < 3; i++) {
    const parsed = parseMarkdownArchive(raw)
    for (const note of ['前备注', '中备注', '后备注']) assert.ok(parsed.prologue.includes(note), note)
    raw = serializeMarkdownArchive(parsed)
    assert.equal(raw.match(/^## 当前记忆$/gm)?.length, 1)
  }
})

test('memory-markdown: 异常情况严格报错', () => {
  // 缺少 frontmatter
  assert.throws(() => parseMarkdownArchive('# 只有标题没有头'), /缺少合法 frontmatter/)

  // 格式版本不符
  assert.throws(() => parseMarkdownArchive('---\nformat: unknown-v9\nscope: global\n---\n'), /不支持的记忆格式版本/)

  // 作用域不匹配
  assert.throws(() => parseMarkdownArchive('---\nformat: qqhub-memory-v1\nscope: group:100\n---\n', { expectedScope: 'group:200' }), /作用域不匹配/)

  // 标记未闭合
  const unclosed = `---
format: qqhub-memory-v1
scope: global
---
<!-- qqhub:entry {"id":"unclosed"} -->
正文内容
`
  assert.throws(() => parseMarkdownArchive(unclosed), /未闭合/)

  // 遇到未配对的结束标记
  const orphanEnd = `---
format: qqhub-memory-v1
scope: global
---
<!-- /qqhub:entry -->
`
  assert.throws(() => parseMarkdownArchive(orphanEnd), /未配对/)

  // 重复 ID
  const dupIds = `---
format: qqhub-memory-v1
scope: global
---
<!-- qqhub:entry {"id":"same_id"} -->
第一条
<!-- /qqhub:entry -->
<!-- qqhub:entry {"id":"same_id"} -->
第二条
<!-- /qqhub:entry -->
`
  assert.throws(() => parseMarkdownArchive(dupIds), /重复的 entry ID/)
})
