// 安全审计（2026-11-27 报告）回归：8 项发现逐条锁死，防回退。
//
// 覆盖：
//   S1 net.js 私网判定从字符串前缀改为结构化 IPv6/IPv4 解析（含 IPv4-mapped / NAT64 / 6to4 / 各保留段）
//   S2 net.js 抓取链路加 undici safeLookup，堵 DNS rebinding 绕过
//   S3 browser/policy.js 复用同一套私网判定（不再只认 fe80/fc/fd 前缀）
//   S4 host/panel/guard.js 支持路由侧登记副作用（模块路由 / 带副作用的精确路由只认 POST）
//   S5 danger.js 包装命令剥离覆盖 nohup/timeout/nice/ionice/setsid/stdbuf/busybox/xargs/chrt/taskset/eval
//   S6 inbound-audio / qzone / stickers 不再默认 allowLocal，阻断任意本机文件外发
//   S7 host/panel/routes-modules.js /modules/open 校验模块 id 且限制在模块根目录内
//   S8 config/modules/http 的 deepMerge 与 JSON 解析忽略 __proto__ / constructor / prototype
//   S9 voice/uv.js GitHub 兜底源改为固定版本 + sha256

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const { isPrivateIp, parseIpv6ToBytes } = await import('../src/core/net.js')
const { isDangerousCommand } = await import('../src/security/danger.js')
const { isPrivateHost } = await import('../src/browser/policy.js')
const { isValidModuleId } = await import('../src/core/modules.js')
const { UV_SOURCES } = await import('../src/voice/uv.js')

// ---------- S1 / S3：私网判定结构化 ----------

test('S1：IPv6 文本能解析成 16 字节（含 :: 压缩、末尾点分 IPv4）', () => {
  assert.equal(parseIpv6ToBytes('::1').length, 16)
  assert.equal(parseIpv6ToBytes('::').length, 16)
  assert.equal(parseIpv6ToBytes('2001:db8::1').length, 16)
  assert.equal(parseIpv6ToBytes('::ffff:127.0.0.1').length, 16)
  assert.equal(parseIpv6ToBytes('fe80::1%eth0').length, 16, 'zone id 要剥掉')
  assert.equal(parseIpv6ToBytes('[::1]').length, 16, '方括号要剥掉')
  assert.equal(parseIpv6ToBytes('not-an-ip'), null)
})

test('S1：私网/保留 IPv6 全段拦下（过去只认 fc/fd/fe80/::1/100::/2001:db8 前缀）', () => {
  for (const ip of [
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    'ff02::1', 'ff05::1:3',
    '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::1', /* pii-scan:ignore */
    '2002:7f00:1::1', '2002:a00:1::1',
    '2001:db8::1', '2001:2::1', '2001:10::1', '100::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:192.168.1.1', '::ffff:169.254.169.254', /* pii-scan:ignore */
    '::7f00:1', '::a00:1',
    'fe80::1%eth0', '[fc00::1]',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 必须判为内网/保留`)
  }
})

test('S1：正常公网 IPv6 不被误判', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2400:3200::1', '2a00:1450:4001::1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 是公网，不应被拦`)
  }
})

test('S1：畸形 IPv6 一律 fail-closed（判为内网）', () => {
  for (const ip of [':::', 'gggg::1', '1:2:3', '::1::2', '12345::1', '', null]) {
    assert.equal(isPrivateIp(ip), true, `${String(ip)} 解析失败必须拦`)
  }
})

test('S3：浏览器策略与 net.js 同一口径（src 复用 isPrivateIp）', () => {
  const policy = src('src/browser/policy.js')
  assert.match(policy, /import \{ isPrivateIp \} from '\.\.\/core\/net\.js'/, '复用同一套判定')
  assert.doesNotMatch(policy, /h\.startsWith\('fe80'\)/, '不再用前缀硬编码')
  for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fc00::1', '2002:7f00:1::1', 'localhost']) { /* pii-scan:ignore */
    assert.equal(isPrivateHost(host), true, `${host} 必须判为内网`)
  }
  assert.equal(isPrivateHost('example.com'), false)
})

// ---------- S2：DNS rebinding ----------

test('S2：抓取链路在 socket 建立前用 safeLookup 二次校验', () => {
  const net = src('src/core/net.js')
  assert.match(net, /export function safeLookup/, '导出 safeLookup 供 undici connect 使用')
  assert.match(net, /new Agent\(\{ connect: \{ lookup: safeLookup \} \}\)/, 'undici Agent 挂上 connect.lookup')
  assert.match(net, /redirect: 'manual'/, '重定向逐跳手工校验')
  // safeLookup 内部必须复用同一私网判定
  const fn = net.match(/export function safeLookup[\s\S]*?\n\}/)?.[0] || ''
  assert.match(fn, /isPrivateIp/, 'safeLookup 必须按 isPrivateIp 拦')
})

// ---------- S4：面板副作用路由 ----------

test('S4：guard.check 支持路由侧登记副作用与模块路由标记', () => {
  const guard = src('src/host/panel/guard.js')
  assert.match(guard, /function check\(req, \{ registeredSideEffect, isModuleRoute = false \} = \{\}\)/, 'check 接收路由侧元数据')
  assert.match(guard, /isModuleRoute \|\| path\.startsWith\('\/ext\/'\) \|\| registeredSideEffect === true/, '模块路由/副作用路由查 cross-site')
  assert.match(guard, /const isSideEffect = registeredSideEffect === true \|\|/, '非提交方法按副作用路由拦')
  assert.match(guard, /'\/bili\/run'/, '商店分发但无前缀的写接口进副作用表')
  assert.match(guard, /'\/douyin\/login'/, 'douyin 登录接口进副作用表')
  assert.match(guard, /'\/qzone\/social\/run'/, 'qzone 写接口进副作用表')
})

test('S4：模块 route() 可声明 sideEffect，并透传给 host 前缀路由', () => {
  const modules = src('src/core/modules.js')
  assert.match(modules, /route: \(path, handler, opts = \{\}\) =>/, 'route 接受第三个参数')
  assert.match(modules, /guarded\.__sideEffect = opts\.sideEffect/, '副作用标记挂到 handler')
  assert.match(modules, /guarded\.__isModuleRoute = true/, '模块路由标记')
  assert.match(modules, /function routeSideEffect\(path\)/, '导出查询函数')
  const http = src('src/host/http.js')
  assert.match(http, /registeredSideEffect: fn\.__sideEffect, isModuleRoute: fn\.__isModuleRoute/, '精确路由透传')
  const host = src('src/host.js')
  assert.match(host, /isModuleRoute: true, registeredSideEffect: mods\.routeSideEffect/, '前缀路由透传')
})

// ---------- S5：包装命令剥离 ----------

test('S5：包装命令一律剥到底，再判定真命令', () => {
  const wrappers = [
    'nohup', 'timeout 5', 'timeout -s 9 5', 'timeout -k 5 10',
    'nice -n 5', 'ionice -c 3', 'setsid', 'stdbuf -o0', 'stdbuf -oL',
    'busybox', 'command', 'env', 'sudo', 'sudo -u root', 'exec -a x',
    'xargs', 'xargs -0', 'xargs -n1', 'xargs -I{}',
    'chrt 1', 'chrt -p 1', 'taskset 0', 'taskset -c 0',
    'time -f %e',
  ]
  for (const w of wrappers) {
    const cmd = `${w} rm -rf /`
    const danger = isDangerousCommand(cmd)
    assert.ok(danger, `${cmd} 必须被识别为危险`)
    assert.match(danger.label, /递归删除根目录/, `${cmd} → ${danger.label}`)
  }
})

test('S5：嵌套 shell -c / eval 里的危险命令也要穿透', () => {
  for (const cmd of [
    'sh -c "nohup rm -rf /"',
    'bash -c "eval \\"rm -rf /\\""',
    'eval "rm -rf /"',
    'eval rm -rf /',
    'sudo sh -c "xargs -0 rm -rf /"',
  ]) {
    assert.ok(isDangerousCommand(cmd), `${cmd} 必须被识别`)
  }
})

test('S5：包装命令剥离后普通命令不误报', () => {
  for (const cmd of [
    'ls -la /etc', 'find /tmp -delete', 'chmod -R 755 ./build',
    'stdbuf -oL ls', 'xargs -0 echo hi', 'nice -n 5 make', 'timeout 30 npm test',
    'ionice -c 3 cat big.log', 'taskset -c 0 node build.js', 'chrt -p 1',
  ]) {
    assert.equal(isDangerousCommand(cmd), null, `${cmd} 不应被误判为危险`)
  }
})

test('S5：系统目录递归删除也拦（不止根目录）', () => {
  for (const cmd of ['rm -rf /etc', 'rm -rf /usr/lib', 'find /etc -delete', 'truncate -s 0 /etc/passwd']) {
    assert.ok(isDangerousCommand(cmd), `${cmd} 必须被识别`)
  }
})

// ---------- S6：allowLocal 收口 ----------

test('S6：入站音频 / 空间配图 / 表情收录不再默认读任意本机文件', () => {
  assert.match(src('src/chat/inbound-audio.js'), /allowLocal: false/, '入站音频不读本机文件')
  assert.match(src('src/features/qzone.js'), /allowLocal: false/, '说说配图不读本机路径')
  assert.match(src('src/modules/stickers/index.js'), /allowLocal: false/, '表情收录不读本机路径')
  // 内部挑图必须先转 base64 再进 post()，不能把内部路径直接放开
  const qzone = src('src/features/qzone.js')
  assert.match(qzone, /base64:\/\/' \+ readFileSync\(img\)\.toString\('base64'\)/, '日记配图转 base64')
  assert.match(qzone, /不允许本地路径|模型工具传入的 images 只允许/, '代码里写清收口理由')
})

test('S6：工具描述不再宣称支持本地路径', () => {
  const diary = src('src/modules/diary/index.js')
  assert.doesNotMatch(diary, /本地路径或网址/, '说说工具描述不得再提本地路径')
  assert.match(diary, /不支持本地路径/)
  const stickers = src('src/modules/stickers/index.js')
  assert.doesNotMatch(stickers, /本地图片路径或图片网址/)
  assert.match(stickers, /base64:\/\/ 数据/)
})

// ---------- S7：模块目录穿越 ----------

test('S7：/modules/open 校验 id 且限制在模块根目录内', () => {
  const routes = src('src/host/panel/routes-modules.js')
  assert.match(routes, /isValidModuleId/, '校验模块 id')
  assert.match(routes, /const rel = relative\(base, target\)/, '算相对路径')
  assert.match(routes, /rel\.startsWith\('\.\.'\) \|\| isAbsolute\(rel\)/, '越界即拒')
  assert.match(routes, /模块路径越界/, '给出明确拒绝文案')
  // id 规则本身
  assert.equal(isValidModuleId('weather'), true)
  assert.equal(isValidModuleId('../etc'), false)
  assert.equal(isValidModuleId('..'), false)
  assert.equal(isValidModuleId('a/b'), false)
  assert.equal(isValidModuleId('C:\\Windows'), false)
})

// ---------- S8：原型污染 ----------

test('S8：deepMerge 与 JSON 解析都忽略原型键', () => {
  const config = src('src/core/config.js')
  assert.match(config, /k === '__proto__' \|\| k === 'constructor' \|\| k === 'prototype'/, 'config deepMerge 过滤')
  const modules = src('src/core/modules.js')
  assert.match(modules, /FORBIDDEN_KEYS/, '模块配置 deepMerge 有禁用键集合')
  assert.match(modules, /if \(FORBIDDEN_KEYS\.has\(k\)\) continue/, '模块 deepMerge 跳过禁用键')
  const http = src('src/host/http.js')
  assert.match(http, /__proto__/, '请求体 JSON 解析过滤原型键')
})

test('S8：原型污染实际被阻断', async () => {
  const { normalize } = await import('../src/core/config.js')
  const before = ({}).polluted
  const cfg = normalize(JSON.parse('{"__proto__":{"polluted":true},"memory":{"enabled":true}}'))
  assert.equal(({}).polluted, before, 'Object.prototype 未被污染')
  assert.equal(cfg.memory.enabled, true, '正常配置照常生效')
})

// ---------- S9：uv 固定版本 + 校验 ----------

test('S9：GitHub 兜底源固定版本并带 sha256，不再 latest/download', () => {
  assert.ok(UV_SOURCES.length >= 1)
  for (const source of UV_SOURCES) {
    assert.match(source.url, /^https:/, `${source.url} 必须是 https`)
    assert.doesNotMatch(source.url, /\/latest\/download\//, `${source.url} 不得用滚动 latest`)
    assert.match(source.sha256 || '', /^[a-f0-9]{64}$/, `${source.url} 必须有 sha256`)
  }
  assert.ok(UV_SOURCES.some((s) => s.url.includes('astral-sh/uv/releases/download/0.13.5/')), 'GitHub 源固定到 0.13.5')
})
// ---------- S4 补：副作用表与面板实际调用方法的一致性 ----------
//
// 这一层专门防「凭印象列清单」：清单漏一条 = 跨站 GET 仍能打穿；
// 清单多列一条只读路由 = 面板自己用 GET 调就被 405 打断。两个方向都测。

test('S4：副作用表不得收录面板用 GET 调用的只读路由（否则面板被打断）', () => {
  const guard = src('src/host/panel/guard.js')
  const panelGet = [
    '/bili/account', '/bili/shots', '/bili/state',
    '/douyin/account', '/douyin/login/status', '/douyin/state',
    '/heybox/account', '/heybox/state', '/heybox/topics',
    '/multi-parser/status', '/qzone/social/state',
  ]
  for (const route of panelGet) {
    assert.doesNotMatch(guard, new RegExp(`'${route.replace(/\//g, '\\/')}'`), `${route} 是面板 GET 只读路由，不能进副作用表`)
  }
})

test('S4：有真实副作用且面板用 POST 调用的路由必须全部收录', () => {
  const guard = src('src/host/panel/guard.js')
  const mustHave = [
    '/bili/run', '/bili/replies', '/bili/shot/delete',
    '/douyin/run', '/douyin/login', '/douyin/dms', '/douyin/confirm-owner', '/douyin/window',
    '/heybox/run', '/heybox/clear-quota', '/heybox/risk/clear',
    '/heybox/qr/start', '/heybox/qr/poll', '/heybox/verify/start', '/heybox/verify/finish',
    '/heybox/login-cookie', '/heybox/topics/refresh', '/heybox/acts/refresh',
    '/multi-parser/test', '/qzone/social/run',
  ]
  for (const route of mustHave) {
    assert.match(guard, new RegExp(`'${route.replace(/\//g, '\\/')}'`), `${route} 必须有副作用保护`)
  }
})

test('S4：只读路由确实不会被 405 拦（负面用例，防清单扩散）', () => {
  const guard = src('src/host/panel/guard.js')
  // 纯粹的状态读取路由不该出现在任何副作用清单里
  for (const route of ['/heybox/post-plan']) {
    assert.doesNotMatch(guard, new RegExp(`'${route.replace(/\//g, '\\/')}'`), `${route} 只读（postPlanState），不该被强制 POST`)
  }
})
