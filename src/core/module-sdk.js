// M2-F · Module SDK 规划层：在现有 modules.js 上消费能力声明（不创建第二套模块系统）
//
// 职责（任务书 M2-F + ADR-0001 §1 能力声明）：
//   - planModules：装载计划 = 在「配置要开」的模块集合上做能力声明检查——
//     requires（缺依赖跳过并报告）、conflicts/provides（同能力替代实现冲突：保留声明序在前者，
//     除非配置显式指定 prefer）、requiresGUI（无 GUI 环境剪枝，entrypoint 零执行）、
//     apiVersion（超出版本跳过）。enabledOf 仍是唯一开关权威（modules.js 的 wanted()）。
//   - createModuleHealth：per-module 健康登记（enabled/disabled/degraded/failed），
//     modules.js 的 start/stop 处消费（任务书 health 能力）。
//
// 红线：不改既有 id/api/setup 语义；本层只做「计划与观测」，装载/卸载仍是 modules.js 的事。

import { validateModuleContract } from './module-contract.js'

/**
 * 生成装载计划。
 * @param {object} o
 * @param {Array<object>} o.defs 候选模块定义（按装载顺序；同 id 保留先出现者，重复者记 skipped）
 * @param {(id: string) => boolean} o.enabledOf 配置开关（唯一开关权威）
 * @param {{ gui: boolean, apiVersion?: number }} o.runtime 运行环境（gui 是否可用）
 * @param {Record<string, string>} [o.prefer] 能力 → 指定实现 moduleId（显式替代实现选择）
 * @returns {{ load: Array<object>, skipped: Array<{id: string, reason: string}>, health: object }}
 */
export function planModules({ defs, enabledOf, runtime, prefer = {} }) {
  if (!Array.isArray(defs)) throw new TypeError('defs 必须是数组')
  if (typeof enabledOf !== 'function') throw new TypeError('enabledOf 必须是函数')
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime 必须是对象')
  const apiVersion = runtime.apiVersion ?? 1

  const load = []
  const skipped = []
  const health = {}
  /** moduleId -> Set(provides) */
  const providedBy = new Map()
  const loadedIds = new Set()

  // —— 第一遍：逐条做与其它模块无关的准入判定（契约 / API / GUI / 开关 / 重复 ID）——
  // 顺序保持不变：同一 id 只保留首现者，健康登记也按声明序写。
  const eligible = []
  for (const raw of defs) {
    const id = String(raw?.id ?? '')
    let def
    try {
      def = validateModuleContract(raw)
    } catch (error) {
      skipped.push({ id: id || '(无名)', reason: `定义不合法：${error.message}` })
      health[id] = { state: 'failed', reason: error.message }
      continue
    }
    if (def.api > apiVersion) {
      skipped.push({ id, reason: `需要扩展接口 v${def.api}，当前 v${apiVersion}` })
      health[id] = { state: 'disabled', reason: 'apiVersion 超出' }
      continue
    }
    if (def.requiresGUI && !runtime.gui) {
      skipped.push({ id, reason: '需要 GUI，当前环境没有（剪枝，entrypoint 零执行）' })
      health[id] = { state: 'disabled', reason: '无 GUI 环境' }
      continue
    }
    if (!enabledOf(id)) {
      skipped.push({ id, reason: '配置开关关闭' })
      health[id] = { state: 'disabled', reason: '配置关闭' }
      continue
    }
    // 重复 ID：只保留先出现者进 load。若两个都进，modules.js 的 live.set 会用后装者
    // 覆盖同名条目，第一份的清理句柄就此丢失（监听器/定时器泄漏）。
    if (loadedIds.has(id)) {
      skipped.push({ id, reason: '重复模块 ID，保留先出现者' })
      continue
    }
    loadedIds.add(id)
    eligible.push(def)
  }

  const providesOf = (def) => new Set(def.provides || [])
  const acceptedCap = () => {
    const caps = new Set()
    for (const caps2 of providedBy.values()) for (const cap of caps2) caps.add(cap)
    return caps
  }

  /**
   * 双向冲突判定。审计 T3.9：过去只看「已装载者是否占了本模块 conflicts」，
   * 于是 A(conflicts: x) 声明在提供 x 的 B 之前时，B 照样被装进来 —— 冲突只生效一半。
   */
  const conflictWith = (def, accepted) => {
    for (const other of accepted) {
      if (other.id === def.id) continue
      for (const cap of def.conflicts || []) {
        if (cap === other.id || (other.provides || []).includes(cap)) return cap
      }
      for (const cap of other.conflicts || []) {
        if (cap === def.id || (def.provides || []).includes(cap)) return cap
      }
    }
    return null
  }

  /** 同能力替代实现：先到先得；prefer 显式点名时落选者在此淘汰。返回落选原因或 null。 */
  const duplicateOf = (def) => {
    for (const cap of def.provides || []) {
      for (const other of load) {
        if (other.id === def.id || !providesOf(other).has(cap)) continue
        return prefer[cap] ? null : { kind: 'dup', cap, otherId: other.id }
      }
    }
    // prefer 显式指定了别的实现：本模块即使先出现也要让位（与过去语义一致）
    for (const cap of def.provides || []) {
      if (prefer[cap] && prefer[cap] !== def.id) return { kind: 'prefer', cap }
    }
    return null
  }

  const accept = (def) => {
    load.push(def)
    providedBy.set(def.id, providesOf(def))
    health[def.id] = { state: 'enabled' }
  }

  const reject = (def, kind, cap) => {
    if (kind === 'conflict') {
      skipped.push({ id: def.id, reason: `与已装载能力冲突：${cap}` })
      health[def.id] = { state: 'disabled', reason: `冲突 ${cap}` }
    } else if (kind === 'prefer') {
      skipped.push({ id: def.id, reason: `能力 ${cap} 已显式指定实现 ${prefer[cap]}（prefer）` })
      health[def.id] = { state: 'disabled', reason: `能力 ${cap} 由 ${prefer[cap]} 提供` }
    } else {
      skipped.push({ id: def.id, reason: `能力 ${cap} 已有实现（替代实现冲突；可用 prefer 指定）` })
      health[def.id] = { state: 'disabled', reason: `替代实现冲突 ${cap}` }
    }
  }

  // —— 第二遍：迭代不动点解析 requires ——
  // 审计 T3.9：过去单趟按声明序，依赖方写在提供方之前就永远「缺依赖」，
  // 与声明顺序强耦合（boot / sync / reload 的可用模块集合会随文件顺序漂移）。
  let pending = eligible.slice()
  for (;;) {
    let progressed = false
    const still = []
    for (const def of pending) {
      const conflict = conflictWith(def, load)
      if (conflict) { reject(def, 'conflict', conflict); progressed = true; continue }
      const dup = duplicateOf(def)
      if (dup) { reject(def, dup.kind, dup.cap); progressed = true; continue }
      const caps = acceptedCap()
      const missing = (def.requires || []).filter((cap) => !caps.has(cap))
      if (missing.length) { still.push(def); continue }
      accept(def)
      progressed = true
    }
    pending = still
    if (!pending.length) break
    if (progressed) continue
    // 无可推进：可能是环形依赖（A 要 b-cap、B 要 a-cap）。整组一起装载的前提是
    // 组内互相满足、且组内没有冲突/重名能力。
    const groupCaps = new Set()
    for (const def of pending) for (const cap of def.provides || []) groupCaps.add(cap)
    const caps = acceptedCap()
    const group = []
    for (const def of pending) {
      if ((def.requires || []).every((cap) => caps.has(cap) || groupCaps.has(cap))) group.push(def)
    }
    const ok = group.length > 0 && group.every((def) => !conflictWith(def, group.filter((x) => x !== def)))
    if (ok) {
      for (const def of group) {
        if (!conflictWith(def, load) && !duplicateOf(def)) accept(def)
      }
      pending = pending.filter((def) => !load.includes(def))
      if (!pending.length) break
    }
    // 剩下的确实无法满足：按声明序报缺依赖。
    const finalCaps = acceptedCap()
    for (const def of pending) {
      const missing = (def.requires || []).filter((cap) => !finalCaps.has(cap))
      skipped.push({ id: def.id, reason: `缺依赖能力：${missing.join(', ')}` })
      health[def.id] = { state: 'disabled', reason: `缺依赖 ${missing.join(', ')}` }
    }
    break
  }

  return { load, skipped, health }
}

/**
 * 健康注册表：modules.js 的 start/stop 消费（任务书 health 能力）。
 * 状态：enabled / disabled / degraded / failed。
 */
export function createModuleHealth() {
  const map = new Map()
  return {
    set(id, state, detail) {
      if (!['enabled', 'disabled', 'degraded', 'failed'].includes(state)) {
        throw new TypeError(`未知健康状态：${state}`)
      }
      map.set(String(id), { state, ...(detail ? { detail: String(detail) } : {}), at: Date.now() })
    },
    get(id) {
      const hit = map.get(String(id))
      return hit ? { ...hit } : null
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, { ...v }]))
    },
    counts() {
      const out = { enabled: 0, disabled: 0, degraded: 0, failed: 0 }
      for (const v of map.values()) out[v.state] = (out[v.state] || 0) + 1
      return out
    },
  }
}
