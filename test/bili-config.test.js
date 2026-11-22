// B 站相关的**宿主配置**回归（实现在商店模块里，这里只管插件自己的配置归一化）。
//   · Cookie 分两个框填：纯值 / 带前缀 / 整串都认；老配置自动拆开；面板只看得到结尾几位
//   · 面板合并：只改一个框时另一个保留；显式清空才清
//   · bili.model（B 站单独选模型）：两个字段都填才算数，坏数据当「跟随全局」
//   · profilePerms：改 B 站头像/签名默认仅主人
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, publicConfig, mergeFromPanel, splitBiliCookie } from '../src/core/config.js'

test('B 站 Cookie 分两个框填：纯值、带前缀、整串都认', () => {
  assert.equal(splitBiliCookie({ sessdata: 'aaa', biliJct: 'bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.equal(splitBiliCookie({ sessdata: 'SESSDATA=aaa', biliJct: 'bili_jct=bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.deepEqual(splitBiliCookie({ sessdata: 'buvid3=z; SESSDATA=a%2C1; bili_jct=b; x=1' }), { sessdata: 'a%2C1', biliJct: 'b', cookie: 'SESSDATA=a%2C1; bili_jct=b' })
})

test('B 站 Cookie：老配置自动拆开；面板只看得到结尾几位；只改一个另一个保留', () => {
  const cur = normalize({ bili: { cookie: 'SESSDATA=old1234; bili_jct=jct9876' } })
  assert.equal(cur.bili.sessdata, 'old1234')
  const pub = publicConfig(cur).bili
  assert.equal(pub.sessdataHint, '…1234')
  assert.equal(pub.sessdata + pub.biliJct + pub.cookie, '', '完整值不回传')
  const next = mergeFromPanel(cur, { bili: { sessdata: '', biliJct: 'new0000' } })
  assert.equal(next.bili.cookie, 'SESSDATA=old1234; bili_jct=new0000', '只改一个，另一个保留')
  const cleared = mergeFromPanel(next, { bili: { sessdata: null, biliJct: null, cookie: null } })
  assert.equal(cleared.bili.cookie, '')
})

test('bili.model：留空跟随全局；两个字段都填才生效；坏数据不炸', () => {
  assert.deepEqual(normalize({}).bili.model, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(normalize({ bili: { model: { provider: ' deepseek ', model: ' deepseek-chat ', reasoningEffort: 'high' } } }).bili.model,
    { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  // 只填一半 → 当没填（不能出现 provider 有、model 空的半残状态）
  assert.deepEqual(normalize({ bili: { model: { provider: 'deepseek' } } }).bili.model, { provider: '', model: '', reasoningEffort: '' })
  // 思考强度不认识 → 留空（= 跟主模型走）
  assert.equal(normalize({ bili: { model: { provider: 'p', model: 'm', reasoningEffort: 'ultra' } } }).bili.model.reasoningEffort, '')
  // 不是对象也不炸
  assert.deepEqual(normalize({ bili: { model: 'deepseek' } }).bili.model, { provider: '', model: '', reasoningEffort: '' })
})

test('profilePerms：改 B 站头像 / 签名默认仅主人，非法值回落', () => {
  assert.equal(normalize({}).profilePerms.biliAvatar, 'owner')
  assert.equal(normalize({}).profilePerms.biliSign, 'owner')
  assert.equal(normalize({ profilePerms: { biliAvatar: 'x' } }).profilePerms.biliAvatar, 'owner')
})
