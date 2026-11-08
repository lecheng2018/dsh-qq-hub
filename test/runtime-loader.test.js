// 运行时能力探测 + 声明式条件装载器：注入桩环境断言六道门禁、剪枝零执行、优先级降序、生产零日志。
// 纪律：全部用例走注入的 fake platform/env/fs/freemem，绝不依赖真机是否 Docker、有无 DISPLAY。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnvironmentDetector } from '../src/runtime/environment-detector.js'
import { ConditionalModuleLoader, validateManifest } from '../src/runtime/module-loader.js'

// ---- 桩件工厂 ----

/** 无头 Linux + Docker 容器（/.dockerenv 命中、512MB 空闲内存、无任何桌面环境变量） */
function headlessDockerDetector(over = {}) {
  return new EnvironmentDetector({
    platform: 'linux',
    env: {},
    existsSync: (p) => p === '/.dockerenv',
    readFileSync: () => '0::/system.slice',
    freemem: () => 512 * 1024 * 1024,
    ...over,
  })
}

/** 生成 manifest 与 entrypoint 调用记录，供「零执行」断言 */
function spyManifest(over = {}) {
  const hits = []
  const manifest = {
    name: 'mod-x',
    version: '1.0.0',
    priority: 0,
    targetPlatforms: ['linux'],
    displayRequirements: ['headless'],
    entrypoint: async () => {
      hits.push(manifest.name)
      return { id: manifest.name }
    },
    ...over,
  }
  return { manifest, hits }
}

// ---- EnvironmentDetector ----

test('isDocker 双查与缓存：哨兵未命中则查 cgroup，二次调用零新 fs 读取', () => {
  const counts = { exists: 0, read: 0 }
  const det = new EnvironmentDetector({
    // 文件头纪律：桩件必须注入 platform——否则在 Windows/macOS 宿主跑测试时
    // isDocker 走「非 Linux 平台确证 false」短路，下面的断言永远到不了 cgroup。
    platform: 'linux',
    existsSync: (p) => { counts.exists++; return p === '/.dockerenv' ? false : false },
    readFileSync: (p) => { counts.read++; return p === '/proc/1/cgroup' ? '12:cpu:/docker/abc' : '' },
  })
  assert.equal(det.isDocker(), true, 'cgroup 含 docker 应判定为容器')
  assert.deepEqual(counts, { exists: 1, read: 1 })
  assert.equal(det.isDocker(), true)
  assert.deepEqual(counts, { exists: 1, read: 1 }, '结果必须缓存，不得重复 fs 探测')
  det.clearDockerCache()
  assert.equal(det.isDocker(), true)
  assert.equal(counts.exists, 2, '清缓存后应重新探测')
})

test('isDocker 短路：哨兵文件命中则不再读 cgroup', () => {
  let reads = 0
  const det = new EnvironmentDetector({
    platform: 'linux',
    existsSync: (p) => p === '/.dockerenv',
    readFileSync: () => { reads++; return '' },
  })
  assert.equal(det.isDocker(), true)
  assert.equal(reads, 0, '|| 短路：哨兵命中时 cgroup 读取次数必须为 0')
})

test('isDocker 抗炸（review C3#1 三态）：非 Linux 平台确证 false；Linux 证据链全断返回 null（未知≠安全）', () => {
  const mac = new EnvironmentDetector({
    platform: 'darwin',
    existsSync: () => false,
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(mac.isDocker(), false, 'macOS 宿主确证非容器')
  const unknown = new EnvironmentDetector({
    platform: 'linux',
    existsSync: () => false,
    readFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
  })
  assert.equal(unknown.isDocker(), null, 'Linux 读不到任何证据 → 未知')
  const v2clean = new EnvironmentDetector({
    platform: 'linux',
    existsSync: () => false,
    readFileSync: () => '0::/\n',
  })
  assert.equal(v2clean.isDocker(), false, 'cgroup v2 读到且无容器标记 → 确证非容器')
  const v2docker = new EnvironmentDetector({
    platform: 'linux',
    existsSync: () => false,
    readFileSync: () => '0::/system.slice/docker-abc.scope\n',
  })
  assert.equal(v2docker.isDocker(), true, 'cgroup v2 带 docker 段 → 确证容器')
})

test('isFnOS 指纹：/etc/fnos-release 或 FNOS_VERSION 环境变量任一命中', () => {
  const byFile = new EnvironmentDetector({ existsSync: (p) => p === '/etc/fnos-release' })
  assert.equal(byFile.isFnOS(), true)
  const byEnv = new EnvironmentDetector({ existsSync: () => false, env: { FNOS_VERSION: '1.1' } })
  assert.equal(byEnv.isFnOS(), true)
  const bare = new EnvironmentDetector({ existsSync: () => false, env: {} })
  assert.equal(bare.isFnOS(), false)
})

test('getDisplayServer 判定顺序照 RFC：win32→gdi、darwin→aqua、wayland 优先 x11、否则 headless', () => {
  assert.equal(new EnvironmentDetector({ platform: 'win32', env: {} }).getDisplayServer(), 'win32-gdi')
  assert.equal(new EnvironmentDetector({ platform: 'darwin', env: { DISPLAY: ':0' } }).getDisplayServer(), 'aqua')
  assert.equal(new EnvironmentDetector({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).getDisplayServer(), 'wayland')
  assert.equal(new EnvironmentDetector({ platform: 'linux', env: { DISPLAY: ':0' } }).getDisplayServer(), 'x11')
  assert.equal(
    new EnvironmentDetector({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }).getDisplayServer(),
    'wayland', '混合桌面下 WAYLAND_DISPLAY 必须优先于 DISPLAY')
  assert.equal(new EnvironmentDetector({ platform: 'linux', env: {} }).getDisplayServer(), 'headless')
})

test('getFreeMemory 走注入 freemem', () => {
  const det = new EnvironmentDetector({ freemem: () => 4096 })
  assert.equal(det.getFreeMemory(), 4096)
})

// ---- ConditionalModuleLoader：核心场景（headless + docker 剪枝 electron 类模块） ----

test('无头容器剪枝 electron 类模块：entrypoint 零执行、getModule 返回 undefined', async () => {
  const pet = spyManifest({
    name: 'desktop-pet',
    targetPlatforms: ['win32', 'darwin', 'linux'],
    displayRequirements: ['win32-gdi', 'aqua', 'x11', 'wayland'], // 强依赖图形层，不含 headless
    environment: { allowDocker: false },
  })
  const snowluma = spyManifest({
    name: 'snowluma-local-process',
    targetPlatforms: ['win32', 'darwin'],
    displayRequirements: ['win32-gdi', 'aqua'],
    hardware: { minFreeMemoryBytes: 1024 * 1024 * 1024 },
    environment: { allowDocker: false },
  })
  const core = spyManifest({ name: 'core-pipeline', priority: 50 })
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector() })
  await loader.loadModules([pet.manifest, snowluma.manifest, core.manifest])

  assert.deepEqual(pet.hits, [], '被剪枝模块的 entrypoint 必须零执行')
  assert.deepEqual(snowluma.hits, [], '被剪枝模块的 entrypoint 必须零执行')
  assert.deepEqual(core.hits, ['core-pipeline'])
  assert.equal(loader.getModule('desktop-pet'), undefined)
  assert.equal(loader.getModule('snowluma-local-process'), undefined)
  assert.deepEqual(loader.getModule('core-pipeline'), { id: 'core-pipeline' })
})

test('Docker 门禁语义：allowDocker:false 在容器内拒、非容器放行；缺省 allowDocker 容器内照常', async () => {
  const m = spyManifest({ name: 'gui-pet', displayRequirements: ['headless'], environment: { allowDocker: false } })
  const dockerLoader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  await dockerLoader.loadModules([m.manifest])
  assert.equal(dockerLoader.getModule('gui-pet'), undefined, '容器内 allowDocker:false 必须剪枝')
  assert.deepEqual(m.hits, [], '剪枝路径 entrypoint 零执行')

  const bareLoader = new ConditionalModuleLoader({
    detector: headlessDockerDetector({ existsSync: () => false }), // 无哨兵、cgroup 不含 docker → 非容器
  })
  await bareLoader.loadModules([m.manifest])
  assert.deepEqual(bareLoader.getModule('gui-pet'), { id: 'gui-pet' }, '非容器环境 allowDocker:false 不拦')

  const dflt = spyManifest({ name: 'docker-ok' }) // 未声明 allowDocker
  const l3 = new ConditionalModuleLoader({ detector: headlessDockerDetector() })
  await l3.loadModules([dflt.manifest])
  assert.ok(l3.getModule('docker-ok'), '缺省 allowDocker 容器内允许装载（RFC 语义：仅显式 false 才拦）')
})

test('loadModules 按 priority 降序装载，且不篡改调用方数组', async () => {
  const order = []
  const mk = (name, priority) => ({
    name, version: '1.0.0', priority,
    targetPlatforms: ['linux'], displayRequirements: ['headless'],
    entrypoint: async () => { order.push(name); return { name } },
  })
  const manifests = [mk('low', 1), mk('high', 10), mk('mid', 5)]
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector() })
  await loader.loadModules(manifests)
  assert.deepEqual(order, ['high', 'mid', 'low'])
  assert.deepEqual(manifests.map((x) => x.priority), [1, 10, 5], '排序须在副本上进行')
})

test('六道门禁逐项：平台/display/必需变量/禁止变量/内存/customDetector 各拦一次', async () => {
  const det = headlessDockerDetector()
  const loader = new ConditionalModuleLoader({ detector: det, debugLog: () => {} })
  const cases = [
    spyManifest({ name: 'gate1', targetPlatforms: ['win32'] }),
    spyManifest({ name: 'gate2', displayRequirements: ['x11'] }),
    spyManifest({ name: 'gate3', environment: { allowDocker: false } }),
    spyManifest({ name: 'gate4r', environment: { requiredEnvVars: ['SOME_TOKEN'] } }),
    spyManifest({ name: 'gate5', hardware: { minFreeMemoryBytes: 1024 * 1024 * 1024 } }),
    spyManifest({ name: 'gate6', environment: { customDetector: () => false } }),
  ]
  for (const c of cases) {
    assert.equal(await loader.evaluateGate(c.manifest), false, `${c.manifest.name} 应被对应门禁拒绝`)
  }
  // deniedEnvVars 的拒绝语义需要「变量存在」这一触发条件：单独用命中桩 env 断言
  const deniedHit = spyManifest({ name: 'gate4d', environment: { deniedEnvVars: ['DISABLE_GUI'] } })
  const hitLoader = new ConditionalModuleLoader({
    detector: headlessDockerDetector({ env: { DISABLE_GUI: '1' } }), debugLog: () => {},
  })
  assert.equal(await hitLoader.evaluateGate(deniedHit.manifest), false, 'deniedEnvVars 命中存在变量必须拒绝')
  assert.equal(await loader.evaluateGate(deniedHit.manifest), true, 'denied 变量未设置不得拦截（与 required 对称）')
  // 反面对照：满足条件则逐一放行
  const passDet = new EnvironmentDetector({
    platform: 'linux', env: { SOME_TOKEN: 'x', NODE_ENV: 'production' },
    existsSync: () => false, readFileSync: () => '', freemem: () => 2 * 1024 * 1024 * 1024,
  })
  const passLoader = new ConditionalModuleLoader({ detector: passDet })
  const passes = [
    spyManifest({ name: 'p1', targetPlatforms: ['win32', 'linux'] }),
    spyManifest({ name: 'p2', displayRequirements: ['headless', 'x11'] }),
    spyManifest({ name: 'p4r', environment: { requiredEnvVars: ['SOME_TOKEN'] } }),
    spyManifest({ name: 'p4d', environment: { deniedEnvVars: ['DISABLE_GUI'] } }),
    spyManifest({ name: 'p5', hardware: { minFreeMemoryBytes: 1024 } }),
    spyManifest({ name: 'p6', environment: { customDetector: async () => true } }),
  ]
  for (const c of passes) {
    assert.equal(await passLoader.evaluateGate(c.manifest), true, `${c.manifest.name} 条件满足应放行`)
  }
})

test('门禁次序契约：前序门禁拒绝后 customDetector 绝不被调用', async () => {
  let probeCalls = 0
  const m = spyManifest({
    name: 'ordered',
    targetPlatforms: ['darwin'], // 第 1 道就不匹配
    environment: { customDetector: () => { probeCalls++; return true } },
  })
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  assert.equal(await loader.evaluateGate(m.manifest), false)
  assert.equal(probeCalls, 0, '短路次序不可乱：平台拒绝时不得执行开发者探针')
})

// ---- 剪枝日志：仅非生产 ----

test("剪枝日志仅 NODE_ENV !== 'production' 时输出，生产环境零日志", async () => {
  const dev = []
  const devLoader = new ConditionalModuleLoader({
    detector: headlessDockerDetector(), // env {} → NODE_ENV undefined ≠ production
    debugLog: (msg) => dev.push(msg),
  })
  const pruned = spyManifest({ name: 'gui-only', displayRequirements: ['aqua'] })
  await devLoader.loadModules([pruned.manifest])
  assert.equal(dev.length, 1, '开发环境剪枝应留一条审计日志')
  assert.match(dev[0], /Pruned module: gui-only/)

  const prod = []
  const prodLoader = new ConditionalModuleLoader({
    detector: headlessDockerDetector({ env: { NODE_ENV: 'production' } }),
    debugLog: (msg) => prod.push(msg),
  })
  const pruned2 = spyManifest({ name: 'gui-only-2', displayRequirements: ['aqua'] })
  await prodLoader.loadModules([pruned2.manifest])
  assert.deepEqual(prod, [], 'production 环境必须零剪枝日志')
  assert.equal(prodLoader.getModule('gui-only-2'), undefined, '静默归静默，剪枝照旧生效')
  assert.deepEqual(pruned2.hits, [], '生产剪枝同样零执行')
})

test('entrypoint 非法（非函数）时门禁通过后明确抛 TypeError，不静默半装载', async () => {
  const broken = {
    name: 'broken', version: '1.0.0', priority: 0,
    targetPlatforms: ['linux'], displayRequirements: ['headless'],
    entrypoint: undefined,
  }
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  await assert.rejects(() => loader.loadModules([broken]), TypeError)
})

test('getModule 不隐式触发装载：查询未知名后 entrypoint 依旧零调用', async () => {
  const m = spyManifest({ name: 'lazy' })
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector() })
  await loader.loadModules([m.manifest])
  const before = m.hits.length
  assert.equal(loader.getModule('ghost'), undefined)
  assert.equal(loader.getModule('lazy').id, 'lazy')
  assert.equal(m.hits.length, before, 'getModule 只读已装载集合，绝不补装载')
})

// ---------- validateManifest：结构校验与归一化（US-004 硬化项） ----------

test('validateManifest：缺 targetPlatforms / displayRequirements 抛出含模块名的可诊断错误', async () => {
  const noPlatforms = { name: 'gui-pet', priority: 0, displayRequirements: ['headless'], entrypoint: async () => ({}) }
  const noDisplay = { name: 'snowluma', priority: 0, targetPlatforms: ['linux'], entrypoint: async () => ({}) }
  assert.throws(() => validateManifest(noPlatforms), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /gui-pet/, '错误文本必须带模块名，不然排障只能猜')
    assert.match(error.message, /targetPlatforms/)
    return true
  })
  assert.throws(() => validateManifest(noDisplay), /snowluma/)
  assert.throws(() => validateManifest(noDisplay), /缺少 displayRequirements/)

  // 走装载器两条入口都得拦下，且在任何 entrypoint 执行之前
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  await assert.rejects(() => loader.evaluateGate(noDisplay), /snowluma.*displayRequirements/)
  let entryHits = 0
  const batch = [
    { name: 'ok-mod', targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: async () => { entryHits++; return {} } },
    noPlatforms,
  ]
  await assert.rejects(() => loader.loadModules(batch), /gui-pet/)
  assert.equal(entryHits, 0, '整批预检：坏 manifest 必须在好模块 entrypoint 执行之前就拦下（不留半装载）')
})

test('validateManifest：manifest 非对象 / 缺 name 明确报错，不静默跳过', () => {
  assert.throws(() => validateManifest(undefined), /必须是对象/)
  assert.throws(() => validateManifest(['a']), /必须是对象/)
  assert.throws(() => validateManifest({ targetPlatforms: ['linux'], displayRequirements: ['headless'] }), /缺少 name/)
})

test('validateManifest：priority 缺省补 0、显式非数字拒绝，且绝不改动调用方对象', () => {
  const bare = { name: 'no-priority', targetPlatforms: ['linux'], displayRequirements: ['headless'] }
  const fixed = validateManifest(bare)
  assert.equal(fixed.priority, 0, '缺省 priority 视为 0')
  assert.equal(bare.priority, undefined, '归一化只作用于返回的副本')
  assert.notEqual(fixed, bare)
  assert.throws(() => validateManifest({ ...bare, priority: 'high' }), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /no-priority.*priority 必须是数字/)
    return true
  })
})

test('loadModules：priority 缺省模块按 0 参与降序调度', async () => {
  const order = []
  const mk = (name, priority) => {
    const m = { name, targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: async () => { order.push(name); return { name } } }
    if (priority !== undefined) m.priority = priority
    return m
  }
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  await loader.loadModules([mk('default-a'), mk('high', 9), mk('low', -3), mk('default-b')])
  assert.deepEqual(order, ['high', 'default-a', 'default-b', 'low'], '缺省 0 排在正数之后、负数之前')
})

test('loadModules：同批同名 manifest 拒绝并报错，不静默覆盖（entrypoint 零执行）', async () => {
  const hits = []
  const mk = (tag) => ({
    name: 'dup-mod', version: tag, priority: 0,
    targetPlatforms: ['linux'], displayRequirements: ['headless'],
    entrypoint: async () => { hits.push(tag); return { tag } },
  })
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  await assert.rejects(() => loader.loadModules([mk('v1'), mk('v2')]), (error) => {
    assert.match(error.message, /模块名重复：dup-mod/)
    return true
  })
  assert.deepEqual(hits, [], '重名预检发生在装载之前：两个版本都不许执行')
  assert.equal(loader.getModule('dup-mod'), undefined)
})

test('loadModules：跨批次同名同样拒绝，已装载导出保持不变', async () => {
  const loader = new ConditionalModuleLoader({ detector: headlessDockerDetector(), debugLog: () => {} })
  const first = { ...spyManifest({ name: 'stable' }).manifest, entrypoint: async () => ({ build: 'first' }) }
  await loader.loadModules([first])
  assert.deepEqual(loader.getModule('stable'), { build: 'first' })
  const second = { ...first, entrypoint: async () => ({ build: 'second' }) }
  await assert.rejects(() => loader.loadModules([second]), /模块名重复：stable.*拒绝覆盖/)
  assert.deepEqual(loader.getModule('stable'), { build: 'first' }, '报错不得顺手把已装载实现换掉')
})


// ===== 2026-11-07 review C3 修复回归 =====

test('门禁3（C3#1）：allowDocker:false 的模块遇「未知」也剪枝；未声明的模块不触发探测', async () => {
  let probed = 0
  const det = new EnvironmentDetector({
    platform: 'linux', env: {},
    existsSync: () => false,
    readFileSync: () => { probed += 1; throw new Error('blocked') },
  })
  const loader = new ConditionalModuleLoader({ detector: det, debugLog: () => {} })
  let ran = false
  const gated = { name: 'gated', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], environment: { allowDocker: false }, entrypoint: async () => { ran = true } }
  const open_ = { name: 'open', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: async () => ({ ok: 1 }) }
  probed = 0
  await loader.loadModules([gated])
  assert.equal(ran, false, '未知容器状态必须拒（旧实现 fail-open 会放行）')
  probed = 0
  await loader.loadModules([open_])
  assert.equal(probed, 0, '未声明 allowDocker 的模块不做容器探测')
  assert.ok(loader.getModule('open'))
})

test('部署声明覆盖（C3#1）：QQHUB_RUNTIME_ENV=container/host 直接定论，优先于 fs 探测', () => {
  const c = new EnvironmentDetector({ platform: 'linux', env: { QQHUB_RUNTIME_ENV: 'container' }, existsSync: () => false, readFileSync: () => '0::/' })
  assert.equal(c.isDocker(), true)
  const h = new EnvironmentDetector({ platform: 'linux', env: { QQHUB_RUNTIME_ENV: 'HOST ' }, existsSync: () => true, readFileSync: () => { throw new Error('never') } })
  assert.equal(h.isDocker(), false)
})

test('requiresGUI 政策位（C3#2）：fnOS/容器/未知一律剪枝，customDetector 不得反向放行', async () => {
  const mk = (det, name) => {
    const loader = new ConditionalModuleLoader({ detector: det, debugLog: () => {} })
    let ran = false
    const m = { name, version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['x11'], requiresGUI: true, environment: { customDetector: () => true }, entrypoint: async () => { ran = true } }
    return { loader, m, ran: () => ran }
  }
  const fnos = new EnvironmentDetector({ platform: 'linux', env: { DISPLAY: ':0', FNOS_VERSION: '1' }, existsSync: (p) => p === '/etc/fnos-release', readFileSync: () => '0::/' })
  const a = mk(fnos, 'gui1'); await a.loader.loadModules([a.m]); assert.equal(a.ran(), false, 'fnOS 禁 GUI（即使 DISPLAY 存在且探针放行）')
  const docker = new EnvironmentDetector({ platform: 'linux', env: { DISPLAY: ':0' }, existsSync: (p) => p === '/.dockerenv', readFileSync: () => '' })
  const b = mk(docker, 'gui2'); await b.loader.loadModules([b.m]); assert.equal(b.ran(), false, '容器禁 GUI')
  const host = new EnvironmentDetector({ platform: 'linux', env: { DISPLAY: ':0', QQHUB_RUNTIME_ENV: 'host' }, existsSync: () => false, readFileSync: () => '0::/' })
  const c = mk(host, 'gui3'); await c.loader.loadModules([c.m]); assert.equal(c.ran(), true, '确证宿主+有显示变量：政策放行')
})

test('manifest 预检补全（C3#4）：坏配置在任何 entrypoint 执行前整批拦下', async () => {
  const det = new EnvironmentDetector({ platform: 'linux', env: {}, existsSync: () => false, readFileSync: () => '0::/' })
  const loader = new ConditionalModuleLoader({ detector: det, debugLog: () => {} })
  let ranA = false
  const good = { name: 'A', version: '1', priority: 10, targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: async () => { ranA = true } }
  const badEnv = { name: 'B', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], environment: { requiredEnvVars: 'FOO' }, entrypoint: async () => {} }
  await assert.rejects(loader.loadModules([good, badEnv]), /requiredEnvVars/)
  assert.equal(ranA, false, '预检在任何入口执行前拦整批——不留半装载')
  const badEntry = { name: 'C', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: 'not-a-fn' }
  await assert.rejects(loader.loadModules([badEntry]), /entrypoint 必须是函数/)
  const badMem = { name: 'D', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], hardware: { minFreeMemoryBytes: '1GB' }, entrypoint: async () => {} }
  await assert.rejects(loader.loadModules([badMem]), /minFreeMemoryBytes/)
})

test('customDetector 抛错只剪该模块、不炸整批（C3#4）；内存探测失败按拒（C3#3）', async () => {
  const det = new EnvironmentDetector({ platform: 'linux', env: { NODE_ENV: 'production' }, existsSync: () => false, readFileSync: () => '0::/', freemem: () => NaN })
  const loader = new ConditionalModuleLoader({ detector: det, debugLog: () => {} })
  let boomRan = false, okRan = false
  const boom = { name: 'boom', version: '1', priority: 5, targetPlatforms: ['linux'], displayRequirements: ['headless'], environment: { customDetector: () => { throw new Error('探针坏了') } }, entrypoint: async () => { boomRan = true } }
  const mem = { name: 'mem', version: '1', priority: 4, targetPlatforms: ['linux'], displayRequirements: ['headless'], hardware: { minFreeMemoryBytes: 1024 }, entrypoint: async () => {} }
  const ok = { name: 'ok', version: '1', priority: 1, targetPlatforms: ['linux'], displayRequirements: ['headless'], entrypoint: async () => { okRan = true } }
  await loader.loadModules([boom, mem, ok])
  assert.equal(boomRan, false, '坏探针剪自己')
  assert.equal(loader.getModule('mem'), undefined, 'freemem NaN 时内存门禁按拒')
  assert.equal(okRan, true, '其他模块照常装载（生产环境零剪枝日志轰炸另测）')
})
