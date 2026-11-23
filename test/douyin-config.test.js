// 抖音配置：插件仍负责配置归一化与面板合并（实现已随商店模块 douyin 2.3.0 搬走）。
// 这里只锁配置契约：总开关默认关、权限默认仅主人、旧配置迁移、面板保存不能改已核对的主人抖音号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { DOUYIN_PERM_KEYS } from '../src/chat/access.js'

const OWNER = { input: 'master01', secUid: 'MS4wOWNER', uid: '4182', nickname: '主人小号', confirmedInput: 'master01' }

test('配置：总开关默认关；只剩 4 项权限且默认仅主人；1.0.x 的私信等设置清掉、主人抖音号留着，shareOwner 上限迁到 share', () => {
  const c = normalize({})
  assert.equal(c.douyin.enabled, false)
  assert.deepEqual(c.douyin.caps, { like: 30, comment: 3, share: 5, atOwner: 3 })
  assert.deepEqual(DOUYIN_PERM_KEYS, ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm'])
  for (const k of DOUYIN_PERM_KEYS) assert.equal(c.profilePerms[k], 'owner')
  assert.equal(c.profilePerms.douyinDm, 'owner', '主动私信默认仅主人')
  const old = normalize({ douyin: { enabled: true, owner: { secUid: 'x', avatar: 'a.jpg' }, atOwnerOnLikeChance: 0.7, dmPollMinutes: 7, minimize: true, shareBias: 'off', caps: { like: 10, shareOwner: 2, dm: 5 } }, profilePerms: { douyinDm: 'all' } })
  assert.deepEqual(old.douyin.owner, { input: '', secUid: 'x', uid: '', nickname: '', confirmedInput: '' })
  assert.equal(old.douyin.atOwnerOnLikeChance, undefined)
  assert.equal(old.douyin.dmPollMinutes, 7, '看私信间隔这个设置又用上了，保留')
  assert.equal(old.douyin.shareBias, 'stingy')
  assert.deepEqual(old.douyin.caps, { like: 10, comment: 3, share: 2, atOwner: 3 })
  assert.equal(old.profilePerms.douyinDm, 'owner', '旧版 douyinDm 含义不同，老配置回到默认仅主人')
})

test('配置：主人抖音号保留；面板保存只能改输入框，改不了 secUid', () => {
  const cur = normalize({ douyin: { owner: OWNER } })
  assert.deepEqual(cur.douyin.owner, OWNER)
  const next = mergeFromPanel(cur, { douyin: { owner: { input: 'other', secUid: 'MS4wHACK', nickname: 'x' } } })
  assert.equal(next.douyin.owner.input, 'other')
  assert.equal(next.douyin.owner.secUid, 'MS4wOWNER')
  assert.equal(next.douyin.owner.nickname, '主人小号')
})
