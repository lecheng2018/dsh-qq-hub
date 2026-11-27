// 审计 S04 的行为锁：内置模块的写接口必须受「GET 类方法 405」约束。
//
// 过去 SIDE_EFFECT_PATHS 只收面板路由——内置模块路由与面板路由同前缀
// （routePrefixFor 对内置模块返回 ''），报告点名的三处
// （memory-privacy 清空/开关、token-billing 重置、voice 安装）一个都没进来。
// 后果：跨站 <img src="…/qq-hub/api/memory-privacy/clear-main?scope=global">、
// 顶层链接点一下、prefetch 这类**不带 Origin 的 GET** 能直接触发它们——
// CSRF Origin 校验对无 Origin 请求是不生效的，这正是那条逻辑的缺口。
//
// 修复：把内置模块的写接口逐条按「写状态 / 删数据 / 派生进程 / 对外发布 / 计费」
// 收进 SIDE_EFFECT_PATHS（与面板条目同一机制、同一口径）。前端对这些全部走 POST。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelGuard } from '../src/host/panel/guard.js'

const guard = createPanelGuard({ getConfig: () => ({ security: { panel: { allowedHosts: [] } } }), log: null })
const req = (method, url, headers = {}) => ({ method, url, headers: { host: '127.0.0.1:13080', ...headers } })

const WRITE_ROUTES = [
  '/memory-privacy/clear-main',
  '/memory-privacy/set-override',
  '/token-usage/reset',
  '/speakup/fire',
  '/purpose/fire',
  '/voice/install',
  '/voice/asr-test',
  '/diary/run',
  '/qzone/delete',
  '/image/gallery/delete',
  '/style/save',
  // 复核补齐：这些 handler 都会写持久状态 / 删数据 / 触发模型计费，
  // 过去只在「无 body 的跨站 GET」下部分可直达，清单里一条都没有。
  '/memory/add',
  '/memory/update',
  '/memory/delete',
  '/memory/restore',
  '/memory/import/commit',
  '/memory/reassign-owner',
  '/memory/extract',
  '/memory/reload',
  '/memory/vector/backfill',
  '/profiles/save',
  '/profiles/delete',
  '/profiles/rebuild',
  '/insights/save',
  '/insights/delete',
  '/sticker/delete',
]

test('S04 · 清单里的每条写接口都真的被判为副作用路径（防止加了枚举没加清单）', () => {
  for (const path of WRITE_ROUTES) {
    const r = guard.check(req('GET', `/qq-hub/api${path}`))
    assert.equal(r.ok, false, `${path} 的 GET 必须被拒`)
    assert.equal(r.code, 405, `${path} 的 GET 应是 405 方法约束，实际 ${r.code}`)
  }
})

test('S04 · 模块写接口的 GET 一律 405（跨站 <img>/顶层链接/prefetch 触发不了）', () => {
  for (const path of WRITE_ROUTES) {
    const r = guard.check(req('GET', `/qq-hub/api${path}`))
    assert.equal(r.ok, false, `${path} 的 GET 必须被拒`)
    assert.equal(r.code, 405, `${path} 的 GET 应是 405 方法约束，实际 ${r.code}`)
  }
})

test('S04 · 模块写接口的 POST 正常放行（面板合法流程不受影响）', () => {
  for (const path of WRITE_ROUTES) {
    const r = guard.check(req('POST', `/qq-hub/api${path}`, { origin: 'http://127.0.0.1:13080' }))
    assert.equal(r.ok, true, `${path} 的同源 POST 应放行`)
  }
})

test('S04 · 只读模块路由不受影响：GET 照常放行', () => {
  for (const path of ['/memory-privacy/stats', '/memory-privacy/list', '/token-usage', '/voice/asr-status']) {
    const r = guard.check(req('GET', `/qq-hub/api${path}`))
    assert.equal(r.ok, true, `${path} 是只读路由，GET 应放行`)
  }
})

test('S04 · 跨站 POST（Origin 不匹配）依然被 CSRF 拦下——方法约束不替代来源校验', () => {
  const r = guard.check(req('POST', '/qq-hub/api/memory-privacy/clear-main', { origin: 'http://evil.example' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 403)
})
