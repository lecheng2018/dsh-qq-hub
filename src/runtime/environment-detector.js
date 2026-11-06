// 运行时环境能力探测（RFC-0001 §5.2 EnvironmentDetector 落地）。
//
// 回答冷启动剪枝需要的四个问题：什么平台、什么显示服务、是否在 Docker 容器、还剩多少空闲内存。
// 所有对宿主的事实（platform / 环境变量 / fs 读取 / freemem / 探测路径）都可经构造函数注入替换，
// 测试注入桩件即可断言，不依赖真机状态；缺省时走本机真实探测。isDocker 结果按实例缓存，
// 冷启动多模块共用一次 fs 探测。

import os from 'node:os'
import fs from 'node:fs'

export class EnvironmentDetector {
  /**
   * @param {object} [deps] 可注入依赖，全部缺省为宿主真实探测
   * @param {string} [deps.platform] 覆盖 process.platform（如 'linux' / 'win32'）
   * @param {Record<string, string | undefined>} [deps.env] 覆盖 process.env
   * @param {(p: string) => boolean} [deps.existsSync] 覆盖 fs.existsSync
   * @param {(p: string, enc: string) => string} [deps.readFileSync] 覆盖 fs.readFileSync
   * @param {() => number} [deps.freemem] 覆盖 os.freemem
   * @param {string} [deps.dockerEnvPath] 容器哨兵文件路径，默认 '/.dockerenv'
   * @param {string} [deps.cgroupPath] cgroup 探测路径，默认 '/proc/1/cgroup'
   * @param {string} [deps.fnosReleasePath] fnOS 指纹路径，默认 '/etc/fnos-release'
   * @param {string} [deps.cgroupMarker] cgroup 内容匹配串，默认 'docker'
   */
  constructor(deps = {}) {
    this.platform = deps.platform ?? process.platform
    this.env = deps.env ?? process.env
    this.existsSync = deps.existsSync ?? ((p) => fs.existsSync(p))
    this.readFileSync = deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc))
    this.freemem = deps.freemem ?? (() => os.freemem())
    this.dockerEnvPath = deps.dockerEnvPath ?? '/.dockerenv'
    this.cgroupPath = deps.cgroupPath ?? '/proc/1/cgroup'
    this.fnosReleasePath = deps.fnosReleasePath ?? '/etc/fnos-release'
    this.cgroupMarker = deps.cgroupMarker ?? 'docker'
    // RFC 原文用静态缓存；这里按实例缓存，注入桩件的测试不会污染真实进程
    this._cachedIsDocker = undefined
  }

  /**
   * 是否运行在 Docker 容器：/.dockerenv 哨兵文件与 /proc/1/cgroup 内容双查，结果缓存。
   * @returns {boolean}
   */
  isDocker() {
    if (this._cachedIsDocker !== undefined) return this._cachedIsDocker
    try {
      // || 短路：哨兵文件命中时不再读 cgroup；cgroup 查询覆盖老式 cgroup v1 容器形态
      this._cachedIsDocker = this.existsSync(this.dockerEnvPath) ||
        this.readFileSync(this.cgroupPath, 'utf8').includes(this.cgroupMarker)
    } catch {
      // macOS/Windows 没有 /proc/1/cgroup，读取抛错按「不在容器」处理，绝不让探测炸穿冷启动
      this._cachedIsDocker = false
    }
    return this._cachedIsDocker
  }

  /** 清空 isDocker 缓存（长驻进程环境变化或测试复位用）。 */
  clearDockerCache() {
    this._cachedIsDocker = undefined
  }

  /**
   * 是否运行在飞牛 NAS（fnOS）：/etc/fnos-release 指纹文件或 FNOS_VERSION 环境变量。
   * @returns {boolean}
   */
  isFnOS() {
    return this.existsSync(this.fnosReleasePath) || this.env.FNOS_VERSION !== undefined
  }

  /**
   * 当前显示服务类型，判定顺序严格照 RFC §5.2：win32 → darwin → WAYLAND_DISPLAY → DISPLAY → headless。
   * @returns {import('./types.js').DisplayServerType}
   */
  getDisplayServer() {
    if (this.platform === 'win32') return 'win32-gdi'
    if (this.platform === 'darwin') return 'aqua'
    // Linux 系（含 freebsd）按环境变量判定，wayland 优先于 x11（混合桌面下 wayland 更新）
    if (this.env.WAYLAND_DISPLAY) return 'wayland'
    if (this.env.DISPLAY) return 'x11'
    return 'headless'
  }

  /**
   * 空闲内存字节数（os.freemem 语义，可注入）。
   * @returns {number}
   */
  getFreeMemory() {
    return this.freemem()
  }

  /**
   * 读取单个环境变量（装载器门禁统一走这里，保证注入 env 全链路生效）。
   * @param {string} name
   * @returns {string | undefined}
   */
  getEnvVar(name) {
    return this.env[name]
  }
}

/** 生产缺省探测器：读真实宿主。装载测试请勿使用它，改为注入桩件实例。 */
export const defaultEnvironmentDetector = new EnvironmentDetector()
