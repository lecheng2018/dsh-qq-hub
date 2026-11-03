// 回归：后台 system 会话必须能看到并使用带 owner 档权限的模块工具。
//
// 真实事故（2026-11-03）：定时刷小黑盒跑在 system:ext-heybox 后台会话里，
// profileToolVisible 对 chat.kind==='system' 两个分支都不命中，heybox_hot /
// heybox_feed / heybox_search 一个都没挂上，她只能回「这轮会话里这些工具
// 都没有挂上来」。system 会话是插件自己开的可信上下文，没有「外人」，应视同主人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileToolVisible, profilePermits } from '../src/chat/access.js'

const cfg = { ownerQQ: '444555666', profilePerms: { heyboxBrowse: 'owner', heyboxPost: 'off' } }

test('system 后台会话：owner 档工具要挂上（定时刷小黑盒的命脉）', () => {
  const chat = { chatId: 'system:ext-heybox', kind: 'system' }
  assert.equal(profileToolVisible(cfg, 'heyboxBrowse', chat), true)
  assert.equal(profilePermits(cfg, 'heyboxBrowse', chat, false).ok, true)
})

test('system 后台会话：off 档仍然拒绝（安全闸不掉）', () => {
  const chat = { chatId: 'system:ext-heybox', kind: 'system' }
  assert.equal(profileToolVisible(cfg, 'heyboxPost', chat), false)
  assert.equal(profilePermits(cfg, 'heyboxPost', chat, false).ok, false)
})

test('system 后台会话：owner 档不再要求 allOwner（后台轮次没有说话人）', () => {
  const chat = { chatId: 'system:ext-heybox', kind: 'system' }
  const r = profilePermits(cfg, 'heyboxBrowse', chat, false)
  assert.equal(r.ok, true)
})

test('QQ 侧语义不变：群聊和陌生人私聊仍然不可见', () => {
  assert.equal(profileToolVisible(cfg, 'heyboxBrowse', { chatId: 'group:1', kind: 'group', groupId: '1' }), false)
  assert.equal(profileToolVisible(cfg, 'heyboxBrowse', { chatId: 'private:999', kind: 'private', userId: '999' }), false)
})

test('QQ 侧语义不变：主人私聊照常放行', () => {
  const chat = { chatId: 'private:444555666', kind: 'private', userId: '444555666' }
  assert.equal(profileToolVisible(cfg, 'heyboxBrowse', chat), true)
  assert.equal(profilePermits(cfg, 'heyboxBrowse', chat, true).ok, true)
})
