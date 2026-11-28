// 运行时环境能力探测（RFC-0001 §5.2 EnvironmentDetector 落地）。
//
// 回答冷启动剪枝需要的四个问题：什么平台、什么显示服务、是否在 Docker 容器、还剩多少空闲内存。
// 所有对宿主的事实（platform / 环境变量 / fs 读取 / freemem / 探测路径）都可经构造函数注入替换，
// 测试注入桩件即可断言，不依赖真机状态；缺省时走本机真实探测。isDocker 结果按实例缓存，
// 冷启动多模块共用一次 fs 探测。

import os from 'node:os'
import fs from 'node:fs'

/**
 * 从 `/proc/self/cgroup` 的内容判断「在不在容器里」——纯函数，单测直接喂文本。
 *
 * 契约是三态的：`true` 在容器里 / `false` 不在 / `null` 这份内容什么都证明不了。
 *
 * 为什么必须有三态：cgroup v2 在容器内（私有 cgroup 命名空间）读出来常常就是一行
 * `0::/`，和宿主机上的输出一模一样。旧实现把「读到了 cgroup 但没有容器标记」判成
 * `false`，于是 Docker 里跑的实例会以为自己在宿主机上（进而走宿主机的路径/端口假设）。
 *
 * @param {string} raw cgroup 文件内容
 * @returns {boolean|null} true=容器证据 / false=宿主机证据 / null=无结论
 */
export function cgroupVerdict(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return null
  // v1 与 v2 的容器标记：命中即正向证据
  if (/docker|containerd|kubepods|libpod|lxc/i.test(text)) return true
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const isV2 = lines.length > 0 && lines.every((line) => line.startsWith('0::'))
  if (isV2) {
    // v2 只有一条 `0::<path>`：path 为根（`0::/`）时容器内外同形，不构成任何结论
    const path = lines[0].slice(3).trim()
    return path === '' || path === '/' ? null : false
  }
  // v1 分层里没有任何容器标记：路径是宿主机的 cgroup 树，可以按非容器处理
  return false
}

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
   * 是否运行在容器：/.dockerenv 哨兵文件与 /proc/1/cgroup 内容双查，结果缓存。
   * 2026-11-07 review C3#1 修复——返回**三态**：true=确认容器 / false=确认非容器 /
   * null=未知。旧实现把「探测失败」缓存成 false（fail-open），allowDocker:false 的
   * 模块在读取被隔离/权限限制的容器里会被放行——现在未知≠安全，门禁侧必须拿
   * `=== false` 才放行禁容器模块。
   * 部署侧显式声明（最高优先，消除 cgroup v2 `0::/` 这类假阴性）：
   *   QQHUB_RUNTIME_ENV=container|host。
   * @returns {true | false | null}
   */
  isDocker() {
    if (this._cachedIsDocker !== undefined) return this._cachedIsDocker
    const declared = String(this.env.QQHUB_RUNTIME_ENV ?? '').trim().toLowerCase()
    if (declared === 'container') { this._cachedIsDocker = true; return true }
    if (declared === 'host') { this._cachedIsDocker = false; return false }
    // 非 Linux 系宿主（win32/darwin）：本进程不可能在 Linux 容器内，直接确证 false
    if (this.platform !== 'linux' && this.platform !== 'freebsd') {
      this._cachedIsDocker = false
      return false
    }
    let positiveEvidence = false
    let anyReliableSignal = false
    try {
      // || 短路：哨兵文件命中时不再读 cgroup；哨兵存在是**正向证据**
      if (this.existsSync(this.dockerEnvPath)) {
        this._cachedIsDocker = true
        return true
      }
    } catch {
      // 哨兵读取失败：继续找独立证据，不直接下结论
    }
    try {
      const cgroup = this.readFileSync(this.cgroupPath, 'utf8')
      const verdict = cgroupVerdict(cgroup)
      // verdict === null：这份内容不构成证据（典型是 cgroup v2 的裸 `0::/`），
      // 不能当成「不在容器」——原来那样会把 Docker 里的运行误判成宿主机。
      anyReliableSignal = verdict !== null
      positiveEvidence = verdict === true
    } catch {
      // 无 cgroup 可读（macOS/Windows 正常缺，Linux 挂载异常也缺）：不构成否定证据
    }
    if (positiveEvidence) {
      this._cachedIsDocker = true
    } else if (anyReliableSignal) {
      // 读到了 cgroup 且无任何容器标记：按非容器处理（macOS/Windows 走不到这里）
      this._cachedIsDocker = false
    } else {
      // 两条证据链都没拿到可靠事实：未知
      this._cachedIsDocker = null
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
