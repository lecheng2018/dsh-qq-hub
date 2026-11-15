// Ark 卡片与 AI 语音（P5 两模块）的回归网：参数校验 / 降级链 / 角色挑选。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildArkParams, arkFallbackSegment, arkFallbackText } from '../src/modules/ark-cards/index.js'
import { extractCharacters, pickCharacter } from '../src/modules/ai-voice/index.js'

// ---------------------------------------------------------------------------
// Ark：参数构造（纯校验）
// ---------------------------------------------------------------------------

test('Ark 参数：title + http(s) jump_url 必填，summary 默认 [分享]，预览图只收 http(s)', () => {
  const r = buildArkParams({ title: '看这个', jump_url: 'https://example.com/x', desc: '好东西' })
  assert.equal(r.error, undefined)
  assert.equal(r.params.title, '看这个')
  assert.equal(r.params.jump_url, 'https://example.com/x')
  assert.equal(r.params.summary, '[分享]')
  assert.equal(r.params.desc, '好东西')
  const withPreview = buildArkParams({ title: 't', jump_url: 'https://x.cn', preview_url: 'https://img/x.png' })
  assert.equal(withPreview.params.preview_url, 'https://img/x.png')
})

test('Ark 参数：缺 title / 非法链接 / 非法预览图，逐项拒绝', () => {
  assert.match(buildArkParams({ jump_url: 'https://x' }).error, /title/)
  assert.match(buildArkParams({ title: 't' }).error, /jump_url/)
  assert.match(buildArkParams({ title: 't', jump_url: 'javascript:alert(1)' }).error, /jump_url/)
  assert.equal(buildArkParams({ title: 't', jump_url: 'https://x', preview_url: 'file:///etc/passwd' }).error, undefined, '非法预览图只是不带出去（见下）')
  assert.equal('preview_url' in buildArkParams({ title: 't', jump_url: 'https://x', preview_url: 'file:///etc/passwd' }).params, false)
})

test('Ark 降级：分享卡段（合法时）与文字摘要（始终有）', () => {
  const seg = arkFallbackSegment({ title: 't', jump_url: 'https://x', desc: 'd' })
  assert.equal(seg.error, undefined)
  assert.equal(seg.segment.type, 'share')
  const text = arkFallbackText({ title: 't', jump_url: 'https://x' })
  assert.match(text, /\[卡片：share/)
})

// ---------------------------------------------------------------------------
// AI 语音：角色抽取与挑选（防御式）
// ---------------------------------------------------------------------------

test('extractCharacters：数组 / {characters} / {data:[...]} 都认；垃圾输入返回空', () => {
  const item = { character_id: '1002', character_name: '小鹿' }
  for (const shape of [[item], { characters: [item] }, { data: [item] }]) {
    const list = extractCharacters(shape)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, '1002')
    assert.equal(list[0].name, '小鹿')
  }
  assert.deepEqual(extractCharacters(undefined), [])
  assert.deepEqual(extractCharacters({ characters: 'x' }), [])
})

test('pickCharacter：精确 id > 精确名 > 包含名；认不出 null', () => {
  const list = [
    { id: '1002', name: '小鹿' },
    { id: '2001', name: '磁带男孩' },
  ]
  assert.equal(pickCharacter(list, '1002').name, '小鹿', '精确 id')
  assert.equal(pickCharacter(list, '磁带男孩').id, '2001', '精确名')
  assert.equal(pickCharacter(list, '磁带').id, '2001', '包含名')
  assert.equal(pickCharacter(list, '不存在'), null)
  assert.equal(pickCharacter([], '1002'), null)
  assert.equal(pickCharacter(list, ''), null)
})
