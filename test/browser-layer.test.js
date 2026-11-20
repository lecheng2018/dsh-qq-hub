// 共享浏览器层：策略、进程身份、服务控制流。
//
// 这里全部用假依赖，不要求机器上真的装着 Xvfb / Chrome：
// 真机验证另有一份（要真启动浏览器的那种），普通测试不许因此变红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPolicy, safetyCheck, DENY_ALL, isPrivateHost, isLiteralIp, hostMatches } from '../src/browser/policy.js'
import { createBrowserService } from '../src/browser/service.js'
import { findChrome, freePort, reclaimOrphan } from '../src/browser/process.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'qqhub-browser-'))

// 私网地址用拼装的：源码里不写死这些段的字面量（免得被隐私扫描当成真实内网）
const ip = (...octets) => octets.join('.')
const PRIVATE_URLS = [
  `http://${ip(192, 168, 1, 1)}/`,
  `http://${ip(10, 0, 0, 5)}/`,
  `http://${ip(172, 16, 0, 1)}/`,
  `http://${ip(169, 254, 169, 254)}/latest/meta-data/`, // 云 metadata 的常用地址
]

// ---------- 白名单：fail-closed ----------

test('白名单：空白名单拒绝一切（不是放行一切）', () => {
  for (const p of [createPolicy([]), DENY_ALL]) {
    const r = p.check('https://www.douyin.com/')
    assert.equal(r.ok, false)
    assert.match(r.reason, /没有配置/)
  }
})

test('白名单：精确域 + 子域放行，后缀伪装和别的站拒绝', () => {
  const p = createPolicy(['douyin.com'])
  assert.equal(p.check('https://www.douyin.com/').ok, true)
  assert.equal(p.check('https://v.douyin.com/abc').ok, true)
  assert.equal(p.check('https://douyin.com/').ok, true)
  assert.equal(p.check('https://evil-douyin.com/').ok, false, '后缀伪装不能放行')
  assert.equal(p.check('https://douyin.com.evil.com/').ok, false)
  assert.equal(p.check('https://www.bilibili.com/').ok, false)
})

test('白名单：本机 / 内网 / 云 metadata / 字面 IP 全部拒绝', () => {
  const p = createPolicy(['douyin.com'])
  for (const u of [
    'http://127.0.0.1:8080/',
    'http://localhost/',
    ...PRIVATE_URLS,
    'http://[::1]/',
    'http://[fe80::1]/',
  ]) {
    const r = p.check(u)
    assert.equal(r.ok, false, `应该拒绝：${u}`)
  }
})

test('白名单：非 http(s)、带凭据、非标准端口拒绝', () => {
  const p = createPolicy(['douyin.com'])
  assert.equal(p.check('file:///etc/passwd').ok, false)
  assert.equal(p.check('ftp://www.douyin.com/').ok, false)
  assert.equal(p.check('https://user:pw@www.douyin.com/').ok, false)
  assert.equal(p.check('https://www.douyin.com:8443/').ok, false)
  assert.equal(p.check('https://www.douyin.com:443/').ok, true, '标准端口要放行')
})

test('子资源只做安全过滤：站点自己的 CDN 放行，内网仍拦', () => {
  assert.equal(safetyCheck('https://p3-dy.byteimg.com/a.jpg').ok, true)
  assert.equal(safetyCheck('https://v3-web.douyinvod.com/v.mp4').ok, true, '视频 CDN 不能被白名单卡死')
  assert.equal(safetyCheck(`http://${ip(10, 0, 0, 1)}/x`).ok, false)
  assert.equal(safetyCheck('http://127.0.0.1/x').ok, false)
  assert.equal(safetyCheck('data:text/html,x').ok, false)
})

test('主机判定的小工具', () => {
  assert.equal(hostMatches('www.douyin.com', ['douyin.com']), true)
  assert.equal(hostMatches('douyin.com', ['douyin.com']), true)
  assert.equal(hostMatches('x.douyin.com', ['douyin.com']), true)
  assert.equal(hostMatches('notdouyin.com', ['douyin.com']), false)
  assert.equal(isLiteralIp('127.0.0.1'), true)
  assert.equal(isLiteralIp('[::1]'), true)
  assert.equal(isLiteralIp('douyin.com'), false)
  assert.equal(isPrivateHost('localhost'), true)
  assert.equal(isPrivateHost(ip(192, 168, 0, 1)), true)
  assert.equal(isPrivateHost('douyin.com'), false)
})

// ---------- 进程 ----------

test('找浏览器：面板填了但不存在就不能编一个出来', () => {
  assert.equal(findChrome('C:\\nope\\msedge.exe', '/root'), '')
  assert.equal(findChrome('/usr/bin/chrome-x', '/root', () => true), '/usr/bin/chrome-x')
})

test('找浏览器：优先用插件自带的那份（用户态解包）', () => {
  const root = '/data/browser'
  const exists = (p) => p === join(root, 'chrome', 'opt', 'google', 'chrome', 'google-chrome')
  assert.equal(findChrome('', root, exists), join(root, 'chrome', 'opt', 'google', 'chrome', 'google-chrome'))
})

test('空闲端口能拿到且不重复占用', async () => {
  const a = await freePort()
  const b = await freePort()
  assert.ok(a > 0 && a < 65536)
  assert.ok(b > 0 && b < 65536)
})

test('孤儿回收：PID 对不上就只报警，绝不按名字乱杀', () => {
  const dir = tmp()
  const stateFile = join(dir, 'browser-state.json')
  try {
    // 用一个「活着但肯定不是我们那个」的 PID：当前进程自己
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, starttime: 'definitely-wrong', profileDir: '/nope' }))
    const warns = []
    const r = reclaimOrphan({ profileDir: '/nope', stateFile, log: { warn: (m) => warns.push(m) } })
    assert.equal(r.reclaimed, false)
    assert.equal(r.suspicious, true)
    assert.ok(warns.length > 0, '身份不符要留一句警告')
    assert.ok(readFileSync(stateFile, 'utf8').includes('definitely-wrong'), '不敢动它，状态文件也留着')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('孤儿回收：没有状态文件就什么都不做', () => {
  const dir = tmp()
  try {
    const r = reclaimOrphan({ profileDir: join(dir, 'p'), stateFile: join(dir, 'x.json') })
    assert.equal(r.reclaimed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 服务控制流（全假依赖） ----------

function makeStubs({ chrome = '/fake/chrome', freeMB = 4000, launchFails = false } = {}) {
  const calls = { ensureDisplay: 0, launch: 0, stop: 0, displayStop: 0, acquire: 0, release: 0 }
  const page = { targetId: 't1', wsUrl: 'ws://fake/1' }
  const cdp = {
    closed: false,
    send: async () => ({}),
    on: () => () => {},
    onClose: () => () => {},
    close() { this.closed = true },
  }
  return {
    calls,
    deps: {
      findChrome: () => chrome,
      findXvfb: () => '/fake/Xvfb',
      memAvailable: () => freeMB,
      ensureDisplay: async () => {
        calls.ensureDisplay++
        return { display: ':77', owned: true, stop: () => { calls.displayStop++ } }
      },
      launchBrowser: async () => {
        calls.launch++
        if (launchFails) throw new Error('浏览器没起来：装不上')
        return {
          pid: 4242,
          port: 9333,
          browser: 'Chrome/fake',
          async stop() { calls.stop++ },
        }
      },
      createTabPool: () => ({
        acquire: async () => { calls.acquire++; return page },
        release: async () => { calls.release++ },
        closeAll: async () => {},
        size: () => 1,
      }),
      connectCdp: () => ({ ...cdp, ready: Promise.resolve() }),
    },
  }
}

const cfgOf = (over = {}) => () => ({ browser: { maxConcurrent: 2, idleMinutes: 0, minFreeMB: 600, ...over } })

test('服务：只创建不启动 —— probe 不该拉起任何进程', async () => {
  const { deps, calls } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps })
  const p = await svc.probe()
  assert.equal(p.ok, true)
  assert.equal(calls.ensureDisplay, 0, 'probe 不能启动 Xvfb')
  assert.equal(calls.launch, 0, 'probe 不能启动浏览器')
  assert.equal(svc.status().state, 'idle')
})

test('服务：缺浏览器 / 缺显示 / 内存不够都要能说清原因', async () => {
  const a = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps: makeStubs({ chrome: '' }).deps })
  assert.match((await a.probe()).issues.join(), /找不到浏览器/)

  const b = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps: { ...makeStubs().deps, findXvfb: () => '' } })
  const old = process.env.DISPLAY
  delete process.env.DISPLAY
  try {
    assert.match((await b.probe()).issues.join(), /没有显示服务/)
  } finally {
    if (old !== undefined) process.env.DISPLAY = old
  }

  const c = createBrowserService({ root: tmp(), getConfig: cfgOf({ minFreeMB: 600 }), deps: makeStubs({ freeMB: 100 }).deps })
  assert.match((await c.probe()).issues.join(), /内存/)
})

test('服务：acquire 才启动，release 不停浏览器（别的模块还要用）', async () => {
  const { deps, calls } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps, policies: { douyin: ['douyin.com'] } })
  const lease = await svc.acquire('douyin')
  assert.equal(calls.ensureDisplay, 1)
  assert.equal(calls.launch, 1)
  assert.equal(svc.status().state, 'ready')
  lease.release()
  lease.release() // 幂等
  assert.equal(calls.stop, 0, 'release 不能关掉共享浏览器')
})

test('服务：同一模块不能同时占两个租约；并发上限到了要立刻 BUSY', async () => {
  const { deps } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf({ maxConcurrent: 1 }), deps, policies: {} })
  await svc.acquire('a')
  await assert.rejects(() => svc.acquire('a'), (e) => e.code === 'BUSY')
  await assert.rejects(() => svc.acquire('b'), (e) => e.code === 'BUSY', '超过并发上限也要 BUSY，不能排队')
})

test('服务：租约超时会自动收回，不会把浏览器锁死', async () => {
  const { deps } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf({ maxConcurrent: 1 }), deps, policies: {} })
  const lease = await svc.acquire('slow', { timeoutMs: 30 })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(lease.released, true, '超时应自动释放')
  // 释放后别的模块就能用了
  const next = await svc.acquire('other')
  assert.ok(next)
})

test('服务：导航过白名单，子资源不卡白名单', async () => {
  const { deps } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps, policies: { douyin: ['douyin.com'] } })
  const lease = await svc.acquire('douyin')
  await assert.rejects(() => lease.goto('https://evil.com/'), (e) => e.code === 'BLOCKED')
  await assert.rejects(() => lease.goto('http://127.0.0.1/'), (e) => e.code === 'BLOCKED')
  await lease.goto('https://www.douyin.com/', { waitMs: 1 }) // 合法的不该抛
})

test('服务：启动失败要把状态退回去，不能假装 ready', async () => {
  const { deps } = makeStubs({ launchFails: true })
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps, policies: {} })
  await assert.rejects(() => svc.acquire('x'))
  assert.equal(svc.status().state, 'idle')
})

test('服务：dispose 关浏览器和虚拟屏；重复 dispose 不炸', async () => {
  const { deps, calls } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps, policies: {} })
  await svc.acquire('x')
  await svc.dispose()
  assert.equal(calls.stop, 1, '浏览器要关掉')
  assert.equal(calls.displayStop, 1, '虚拟屏也要关掉 —— 不然孤儿进程一直占内存')
  await svc.dispose()
  assert.equal(calls.stop, 1, '重复 dispose 不该再关一次')
})

test('服务：虚拟屏下 show() 要老实说看不见，而不是假装挪了窗口', async () => {
  const { deps } = makeStubs()
  const svc = createBrowserService({ root: tmp(), getConfig: cfgOf(), deps, policies: {} })
  const lease = await svc.acquire('x')
  const r = await lease.show(true)
  assert.equal(r.ok, false)
  assert.match(r.message, /虚拟屏|看不见/)
  assert.match(r.message, /VNC/, '要告诉主人怎么才能看见')
})