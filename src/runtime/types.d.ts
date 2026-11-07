// RFC-0001 §5.1 条件装载器 manifest 契约的类型声明（Module Manifest Schema）。
// 本仓库是 ESM JavaScript，此文件仅供编辑器/类型检查消费，不引入任何 TS 编译工具链。
// 实现见 environment-detector.js 与 module-loader.js；运行时门禁行为以 RFC §5.2 为准。

/**
 * 物理平台类型
 */
export type PlatformType = 'win32' | 'linux' | 'darwin' | 'freebsd'

/**
 * 显示服务类型：无头环境统一为 headless
 */
export type DisplayServerType = 'headless' | 'x11' | 'wayland' | 'aqua' | 'win32-gdi'

/**
 * 硬件约束。requireGpu 按 RFC §5.1 预留声明位；§5.2 的六道门禁未含 GPU 判定，
 * 装载器暂不消费该字段（用到时以 customDetector 或后续门禁扩展落地，避免虚设承诺）
 */
export interface HardwareConstraints {
  readonly minFreeMemoryBytes?: number
  readonly requireGpu?: boolean
}

/**
 * 环境约束：Docker 许可、环境变量依赖/排斥、自定义探针
 */
export interface EnvironmentConstraints {
  readonly allowDocker?: boolean
  readonly requiredEnvVars?: ReadonlyArray<string>
  readonly deniedEnvVars?: ReadonlyArray<string>
  /**
   * 开发者自定义探针，门禁第 6 道、唯一可异步。
   * 运行时装载器会把 EnvironmentDetector 实例作为首参传入（方便复用探测事实）；
   * 声明成无参函数同样兼容
   */
  readonly customDetector?: (detector?: unknown) => boolean | Promise<boolean>
}

/**
 * 模块元数据规范：每个受装载器管辖的功能模块必须在包入口导出遵循该规范的 manifest 描述符。
 * entrypoint 只在全部门禁通过后才被 await——被剪枝模块的入口代码零执行
 */
export interface ModuleManifest {
  readonly name: string
  readonly version: string
  /**
   * 数值越大越先装载（loadModules 按 priority 降序调度）。
   * 声明可缺省：validateManifest 归一化时补默认值 0，但显式给非数字仍会被拒绝
   */
  readonly priority?: number
  readonly targetPlatforms: ReadonlyArray<PlatformType>
  readonly displayRequirements: ReadonlyArray<DisplayServerType>
  readonly hardware?: HardwareConstraints
  readonly environment?: EnvironmentConstraints
  /**
   * GUI 政策位（review C3#2）：true = 强依赖可连接的图形会话。除 displayRequirements
   * 匹配外，还要求**确认非容器且非 fnOS**（isDocker()===false 且 !isFnOS()）才放行；
   * 容器/未知/fnOS 一律剪枝，customDetector 不得反向放行该政策。
   */
  readonly requiresGUI?: boolean
  readonly entrypoint: () => Promise<any>
}
