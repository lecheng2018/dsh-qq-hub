// Batch 2 / T2.5：浏览器策略尾点绕过、CDP 协议盲区、安装脚本命令注入与下载来源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isPrivateHost, safetyCheck, hostMatches } from '../src/browser/policy.js'
import { schemeAllowed } from '../src/browser/cdp.js'
import { hasCommand, isTrustedDownloadUrl } from '../src/browser/install.js'

test('T2.5：尾点主机名按环回处理（FQDN 绝对形式的绕过）', () => {
  assert.equal(isPrivateHost('localhost.'), true)
  assert.equal(isPrivateHost('foo.localhost..'), true)
  assert.equal(isPrivateHost('LOCALHOST.'), true)
  assert.equal(isPrivateHost('example.com.'), false)
  assert.equal(safetyCheck('http://localhost.:13080/qq-hub/api/state').ok, false)
  assert.equal(safetyCheck('http://a.localhost./').ok, false)
  // 白名单匹配也要吃尾点，否则同一站点会被判成不同域
  assert.equal(hostMatches('www.douyin.com.', ['douyin.com']), true)
})

test('T2.5：Fetch 域协议闸不放行 ws/wss/file，放行 data/blob/about 与 http(s)', () => {
  assert.equal(schemeAllowed('ws://127.0.0.1:9222/devtools/page/x'), false)
  assert.equal(schemeAllowed('wss://example.com/socket'), false)
  assert.equal(schemeAllowed('file:///etc/passwd'), false)
  assert.equal(schemeAllowed('ftp://example.com/x'), false)
  assert.equal(schemeAllowed('data:image/png;base64,AA'), true)
  assert.equal(schemeAllowed('blob:https://a.test/123'), true)
  assert.equal(schemeAllowed('about:blank'), true)
  assert.equal(schemeAllowed('https://www.douyin.com/'), true)
})

test('T2.5：hasCommand 只传位置参数，注入串不会被执行', () => {
  const marker = join(tmpdir(), `qqhub-b2-inject-${process.pid}`)
  rmSync(marker, { force: true })
  assert.equal(hasCommand(`sh; touch ${marker}`), false)
  assert.equal(existsSync(marker), false, '注入串绝不能被执行')
  assert.equal(hasCommand('node'), true)
  assert.equal(hasCommand(''), false)
})

test('T2.5：下载来源白名单只认受信任域的 https', () => {
  assert.equal(isTrustedDownloadUrl('https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'), true)
  assert.equal(isTrustedDownloadUrl('https://redirector.gvt1.com/edgedl/chrome/x.deb'), true)
  assert.equal(isTrustedDownloadUrl('https://evil.example/x.deb'), false)
  assert.equal(isTrustedDownloadUrl('https://gvt1.com.evil.example/x.deb'), false)
  assert.equal(isTrustedDownloadUrl('http://dl.google.com/x.deb'), false)
  assert.equal(isTrustedDownloadUrl('file:///etc/passwd'), false)
})
