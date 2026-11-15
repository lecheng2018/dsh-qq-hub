// 只读白名单注册表（read-actions.js）的回归网。
//
// 守的红线：白名单只对「重试也无害」的动作放行。运行时登记是给模块用的口子，
// 一旦把 send_/set_/delete_/upload_ 放进来，unknown 重试就会变成重复发送——
// 这是全插件最危险的一类错误，所以前缀门槛必须 fail-closed。
import test from 'node:test'
import assert from 'node:assert/strict'

import { registerReadActions, isReadAction, snapshotReadActions } from '../src/onebot/read-actions.js'

test('内置清单完整：迁移前的全部动作都在', () => {
  const base = [
    'get_login_info', 'get_status', 'get_stranger_info', 'get_friend_list', 'get_group_list',
    'get_group_info', 'get_group_member_info', 'get_group_member_list', 'get_msg', 'get_forward_msg',
    'get_group_msg_history', 'get_friend_msg_history', 'get_group_file_url', 'get_private_file_url',
    'get_record', 'get_image', 'get_qzone_feeds', 'get_qzone_msg_list', 'get_qzone_msg_detail',
    'get_doubt_friends_add_request', 'can_send_group_msg', 'can_send_private_msg',
    'fetch_ptt_text', 'fetch_custom_face',
  ]
  for (const action of base) assert.ok(isReadAction(action), `${action} 应该在白名单里`)
})

test('运行时登记：允许前缀生效、重复登记幂等', () => {
  const r1 = registerReadActions(['get_fileset_id', 'get_flash_file_list', 'download_fileset'])
  assert.deepEqual(r1.rejected, [])
  assert.ok(isReadAction('get_fileset_id'))
  const r2 = registerReadActions(['get_fileset_id'])
  assert.deepEqual(r2.added, [], '重复登记不该再新增')
})

test('前缀门槛 fail-closed：send_/set_/delete_/upload_ 一律拒收', () => {
  const r = registerReadActions([
    'send_flash_msg', 'set_msg_emoji_like', 'delete_group_file', 'upload_group_file',
    '', 'xxxx_nonsense', null, 42,
  ])
  assert.deepEqual(r.added, [], '不该有任何名字混进白名单')
  assert.deepEqual(r.rejected, ['send_flash_msg', 'set_msg_emoji_like', 'delete_group_file', 'upload_group_file', 'xxxx_nonsense', '42'])
  assert.ok(!isReadAction('send_flash_msg'), '发送动作绝不能被判成只读')
})

test('isReadAction 对垃圾输入 fail-closed（返回 false，不抛错）', () => {
  for (const bad of [undefined, null, '', 0, {}, Symbol('x')]) {
    assert.equal(isReadAction(bad), false)
  }
})

test('snapshot 稳定排序且不受登记顺序影响', () => {
  const snap = snapshotReadActions()
  assert.deepEqual(snap, [...snap].sort())
  assert.ok(snap.includes('get_login_info'))
})
