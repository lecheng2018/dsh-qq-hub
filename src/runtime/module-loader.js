// 声明式跨平台条件装载器（RFC-0001 §5.2 ConditionalModuleLoader 落地）。
//
// 冷启动按 manifest 六道门禁（平台 → display → Docker → 环境变量 → 内存 → customDetector）剪枝：
// 未通过门禁的模块，其 entrypoint 绝不会被 await——桌面重依赖（Electron/Native 绑定）在无头
// NAS/Docker 上达成零代码执行、零句柄占用。门禁事实全部取自注入的 detector（缺省为宿主真实
// 探测），测试可在纯桩环境下断言。剪枝日志仅 NODE_ENV!=='production' 时输出，生产零日志轰炸。
// 本装载器只管 RFC §5 的 runtime 层，与 src/core/modules.js 插件内核互不相干、互不改动。

import { defaultEnvironmentDetector } from './environment-detector.js'

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
    // 1. 物理平台匹配
    if (!manifest.targetPlatforms.includes(this.detector.platform)) {
      return false
    }

    // 2. 显示环境匹配（headless 下强依赖图形层的模块在此被拦）
    if (!manifest.displayRequirements.includes(this.detector.getDisplayServer())) {
      return false
    }

    // 3. Docker 环境门禁：仅显式声明 allowDocker:false 才拦容器（缺省允许，照 RFC 语义）
    if (this.detector.isDocker() && manifest.environment?.allowDocker === false) {
      return false
    }

    // 4. 环境变量依赖校验：required 必须全存在，denied 任一命中即拒（与 required 对称）
    const requiredEnvVars = manifest.environment?.requiredEnvVars
    if (requiredEnvVars && !requiredEnvVars.every((envKey) => !!this.detector.getEnvVar(envKey))) {
      return false
    }
    const deniedEnvVars = manifest.environment?.deniedEnvVars
    if (deniedEnvVars && deniedEnvVars.some((envKey) => !!this.detector.getEnvVar(envKey))) {
      return false
    }

    // 5. 内存门禁过滤（truthy 判断照 RFC：minFreeMemoryBytes 为 0/未设视为不设限）
    if (manifest.hardware?.minFreeMemoryBytes) {
      if (this.detector.getFreeMemory() < manifest.hardware.minFreeMemoryBytes) {
        return false
      }
    }

    // 6. 开发者自定义探针（唯一可异步门禁；运行时把 detector 作为首参传入便于复用探测事实，
    //    探针声明成无参也兼容）。前序门禁已拒时绝不会走到这里——测试可钉住该调用次序契约
    if (manifest.environment?.customDetector) {
      const result = await manifest.environment.customDetector(this.detector)
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
    // 按优先级降序排序（拷贝一份，不篡改调用方数组）
    const sorted = [...manifests].sort((a, b) => b.priority - a.priority)

    for (const manifest of sorted) {
      const passed = await this.evaluateGate(manifest)
      if (passed) {
        // 门禁已过却无可调用 entrypoint：明确报错而非静默半装载（对齐内核 fail 清晰的原则）
        if (typeof manifest.entrypoint !== 'function') {
          throw new TypeError(`[Loader] 模块 ${manifest.name} 已通过门禁但 entrypoint 不是可调用函数`)
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
