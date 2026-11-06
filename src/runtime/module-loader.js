// 声明式跨平台条件装载器（RFC-0001 §5.2 ConditionalModuleLoader 落地）。
//
// 冷启动按 manifest 六道门禁（平台 → display → Docker → 环境变量 → 内存 → customDetector）剪枝：
// 未通过门禁的模块，其 entrypoint 绝不会被 await——桌面重依赖（Electron/Native 绑定）在无头
// NAS/Docker 上达成零代码执行、零句柄占用。门禁事实全部取自注入的 detector（缺省为宿主真实
// 探测），测试可在纯桩环境下断言。剪枝日志仅 NODE_ENV!=='production' 时输出，生产零日志轰炸。
// 本装载器只管 RFC §5 的 runtime 层，与 src/core/modules.js 插件内核互不相干、互不改动。

import { defaultEnvironmentDetector } from './environment-detector.js'

/**
 * manifest 结构校验与归一化（US-004 顺带的硬化项，前棒 verifier 记账）。
 * 只判「装载器能不能干活」的最低要求：缺门禁必需字段就报出**带模块名**的可诊断错误，
 * 而不是等到 evaluateGate 里对 undefined 调 .includes 抛一句看不懂的 TypeError。
 * 返回归一化副本（priority 缺省补 0），绝不改动调用方传入的对象。
 * @param {import('./types.js').ModuleManifest} manifest
 * @returns {import('./types.js').ModuleManifest}
 */
export function validateManifest(manifest) {
  const label = typeof manifest?.name === 'string' && manifest.name ? manifest.name : '<未命名模块>'
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError(`[Loader] 模块 ${label} 的 manifest 必须是对象，收到 ${Array.isArray(manifest) ? '数组' : typeof manifest}`)
  }
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new TypeError(`[Loader] manifest 缺少 name：装载器按 name 记账与去重，未命名模块无法处理`)
  }
  if (!Array.isArray(manifest.targetPlatforms)) {
    throw new TypeError(`[Loader] 模块 ${label} 的 manifest 缺少 targetPlatforms（应为平台数组，RFC §5.1）`)
  }
  if (!Array.isArray(manifest.displayRequirements)) {
    throw new TypeError(`[Loader] 模块 ${label} 的 manifest 缺少 displayRequirements（应为显示环境数组，RFC §5.1）`)
  }
  if (manifest.priority !== undefined && !Number.isFinite(manifest.priority)) {
    throw new TypeError(`[Loader] 模块 ${label} 的 manifest.priority 必须是数字，收到 ${JSON.stringify(manifest.priority)}`)
  }
  // priority 缺省视为 0：RFC §5.1 声明必填，但漏写一项不该让整批装载炸掉
  return { ...manifest, priority: manifest.priority ?? 0 }
}

/**
 * 同批 manifest 重名检测：直接拒绝而不是静默覆盖——「同名后装版本吃掉先装版本」会让
 * 装载结果不可追溯（loadedModules 以 name 为键）。
 * @param {ReadonlyArray<import('./types.js').ModuleManifest>} manifests
 */
function assertUniqueNames(manifests) {
  const seen = new Set()
  for (const m of manifests) {
    if (seen.has(m.name)) {
      throw new Error(`[Loader] 模块名重复：${m.name}（同名 manifest 拒绝装载，不静默覆盖）`)
    }
    seen.add(m.name)
  }
}

export class ConditionalModuleLoader {
  /**
   * @param {object} [deps]
   * @param {import('./environment-detector.js').EnvironmentDetector} [deps.detector] 能力探测注入，缺省走宿主
   * @param {(msg: string) => void} [deps.debugLog] 剪枝日志出口，缺省 console.debug
   */
  constructor(deps = {}) {
    this.detector = deps.detector ?? defaultEnvironmentDetector
    this.debugLog = deps.debugLog ?? ((msg) => console.debug(msg))
    /** @type {Map<string, any>} 已通过门禁并完成懒 import 的模块导出 */
    this.loadedModules = new Map()
  }

  /**
   * RFC §5.2 六道门禁求值，顺序严格照原文：任何一道不过立即 false。
   * @param {import('./types.js').ModuleManifest} manifest
   * @returns {Promise<boolean>}
   */
  async evaluateGate(manifest) {
    // 结构先校验：缺 targetPlatforms/displayRequirements 直接报出模块名，不拿 TypeError 猜
    const m = validateManifest(manifest)

    // 1. 物理平台匹配
    if (!m.targetPlatforms.includes(this.detector.platform)) {
      return false
    }

    // 2. 显示环境匹配（headless 下强依赖图形层的模块在此被拦）
    if (!m.displayRequirements.includes(this.detector.getDisplayServer())) {
      return false
    }

    // 3. Docker 环境门禁：仅显式声明 allowDocker:false 才拦容器（缺省允许，照 RFC 语义）
    if (this.detector.isDocker() && m.environment?.allowDocker === false) {
      return false
    }

    // 4. 环境变量依赖校验：required 必须全存在，denied 任一命中即拒（与 required 对称）
    const requiredEnvVars = m.environment?.requiredEnvVars
    if (requiredEnvVars && !requiredEnvVars.every((envKey) => !!this.detector.getEnvVar(envKey))) {
      return false
    }
    const deniedEnvVars = m.environment?.deniedEnvVars
    if (deniedEnvVars && deniedEnvVars.some((envKey) => !!this.detector.getEnvVar(envKey))) {
      return false
    }

    // 5. 内存门禁过滤（truthy 判断照 RFC：minFreeMemoryBytes 为 0/未设视为不设限）
    if (m.hardware?.minFreeMemoryBytes) {
      if (this.detector.getFreeMemory() < m.hardware.minFreeMemoryBytes) {
        return false
      }
    }

    // 6. 开发者自定义探针（唯一可异步门禁；运行时把 detector 作为首参传入便于复用探测事实，
    //    探针声明成无参也兼容）。前序门禁已拒时绝不会走到这里——测试可钉住该调用次序契约
    if (m.environment?.customDetector) {
      const result = await m.environment.customDetector(this.detector)
      if (!result) return false
    }

    return true
  }

  /**
   * 按 priority 降序逐一过闸装载：过闸才 await entrypoint() 懒 import（隔离 V8 编译与
   * Native 绑定装载），被剪枝模块的 entrypoint 零执行。
   * @param {ReadonlyArray<import('./types.js').ModuleManifest>} manifests
   * @returns {Promise<void>}
   */
  async loadModules(manifests) {
    // 整批先校验 + 重名预检：坏 manifest 一律在任何 entrypoint 执行之前拦下，不留半装载状态
    // （map 产出副本，后续排序绝不触碰调用方数组——US-002 立过的不篡改契约）
    const validated = manifests.map((m) => validateManifest(m))
    assertUniqueNames(validated)

    // 按优先级降序排序（priority 已由 validateManifest 归一化，缺省即 0）
    const sorted = validated.sort((a, b) => b.priority - a.priority)

    for (const manifest of sorted) {
      const passed = await this.evaluateGate(manifest)
      if (passed) {
        // 门禁已过却无可调用 entrypoint：明确报错而非静默半装载（对齐内核 fail 清晰的原则）
        if (typeof manifest.entrypoint !== 'function') {
          throw new TypeError(`[Loader] 模块 ${manifest.name} 已通过门禁但 entrypoint 不是可调用函数`)
        }
        // 跨批次重名同样拒绝：loadedModules 以 name 为键，静默覆盖等于偷换已装载实现
        if (this.loadedModules.has(manifest.name)) {
          throw new Error(`[Loader] 模块名重复：${manifest.name}（更早的 loadModules 调用已装载，拒绝覆盖）`)
        }
        // 动态延迟导入：剪枝路径绝不允许执行到这一行
        const moduleExports = await manifest.entrypoint()
        this.loadedModules.set(manifest.name, moduleExports)
      } else {
        // 剪枝跳过，仅非生产环境留 Debug 审计记录，防止生产日志轰炸。
        // NODE_ENV 取注入 env，生产行为由部署者环境决定
        if (this.detector.env.NODE_ENV !== 'production') {
          this.debugLog(`[Loader] Pruned module: ${manifest.name} due to gate evaluation failure.`)
        }
      }
    }
  }

  /**
   * 只返回已装载模块的导出；未装载返回 undefined，绝不隐式触发装载。
   * @template T
   * @param {string} name
   * @returns {T | undefined}
   */
  getModule(name) {
    return this.loadedModules.get(name)
  }
}
