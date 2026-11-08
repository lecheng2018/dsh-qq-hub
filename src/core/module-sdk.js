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
    // 缺依赖：requires 的能力必须由「本次要装载」的其他模块提供
    const missing = (def.requires || []).filter((cap) => {
      for (const [otherId, caps] of providedBy) {
        if (otherId !== id && caps.has(cap)) return false
      }
      return true
    })
    if (missing.length) {
      skipped.push({ id, reason: `缺依赖能力：${missing.join(', ')}` })
      health[id] = { state: 'disabled', reason: `缺依赖 ${missing.join(', ')}` }
      continue
    }
    // 冲突：conflicts 列出的能力/模块 id 已被在载者占用
    const conflict = (def.conflicts || []).find((cap) => {
      for (const [otherId, caps] of providedBy) {
        if (otherId !== id && (caps.has(cap) || otherId === cap)) return true
      }
      return false
    })
    if (conflict) {
      skipped.push({ id, reason: `与已装载能力冲突：${conflict}` })
      health[id] = { state: 'disabled', reason: `冲突 ${conflict}` }
      continue
    }
    // 同能力替代实现：先到先得（声明序）；prefer 显式点名时，落选者在此被淘汰
    const losesToPrefer = (def.provides || []).find((cap) => prefer[cap] && prefer[cap] !== id)
    if (losesToPrefer) {
      skipped.push({ id, reason: `能力 ${losesToPrefer} 已显式指定实现 ${prefer[losesToPrefer]}（prefer）` })
      health[id] = { state: 'disabled', reason: `能力 ${losesToPrefer} 由 ${prefer[losesToPrefer]} 提供` }
      continue
    }
    const dupCap = (def.provides || []).find((cap) => {
      for (const [otherId, caps] of providedBy) {
        if (otherId !== id && caps.has(cap)) {
          return prefer[cap] ? prefer[cap] !== id : true
        }
      }
      return false
    })
    if (dupCap) {
      skipped.push({ id, reason: `能力 ${dupCap} 已有实现（替代实现冲突；可用 prefer 指定）` })
      health[id] = { state: 'disabled', reason: `替代实现冲突 ${dupCap}` }
      continue
    }

    // 重复 ID：只保留先出现者进 load。若两个都进，modules.js 的 live.set 会用后装者
    // 覆盖同名条目，第一份的清理句柄就此丢失（监听器/定时器泄漏）。
    if (loadedIds.has(id)) {
      skipped.push({ id, reason: '重复模块 ID，保留先出现者' })
      continue
    }

    load.push(def)
    loadedIds.add(id)
    providedBy.set(id, new Set(def.provides || []))
    health[id] = { state: 'enabled' }
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
