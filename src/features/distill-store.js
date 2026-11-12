import { existsSync, readFileSync } from 'node:fs'
import { writeJson } from '../core/store.js'
import { mergeProfile } from './distill.js'

const keyOf = (gid, uid) => `group:${String(gid)}#${String(uid)}`
const empty = () => ({ version: 1, rev: 0, targets: [], profiles: {} })

function validate(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.targets) || !state.profiles || typeof state.profiles !== 'object') {
    throw new Error('蒸馏 store 结构不符合预期')
  }
  return { ...empty(), ...state, rev: Number(state.rev) || 0, targets: [...state.targets], profiles: { ...state.profiles } }
}

export function createDistillStore({ file, legacy = [] }) {
  let state
  if (existsSync(file)) {
    try { state = validate(JSON.parse(readFileSync(file, 'utf8'))) } catch (error) {
      throw new Error(`蒸馏 store 无法读取，已拒绝启动且不会覆盖原文件：${error.message}`)
    }
  } else {
    state = empty()
    for (const row of legacy) {
      if (!row?.gid || !row?.uid) continue
      if (!state.targets.some((target) => String(target.gid) === String(row.gid) && String(target.uid) === String(row.uid))) {
        state.targets.push({ gid: String(row.gid), uid: String(row.uid), name: String(row.name || row.uid) })
      }
      if (row.profile) state.profiles[keyOf(row.gid, row.uid)] = row.profile
    }
    if (state.targets.length || Object.keys(state.profiles).length) writeJson(file, state)
  }

  function save(next) {
    next.version = 1
    next.rev = (Number(next.rev) || 0) + 1
    writeJson(file, next)
    state = next
  }
  const targets = () => state.targets.map((target) => ({ ...target }))
  const of = (gid, uid) => state.profiles[keyOf(gid, uid)] || null
  const list = () => {
    const rows = targets().map((target) => ({ ...target, profile: of(target.gid, target.uid) }))
    const seen = new Set(rows.map((row) => `${row.gid}#${row.uid}`))
    for (const [key, profile] of Object.entries(state.profiles)) {
      const match = /^group:(\d+)#(\d+)$/.exec(key)
      if (!match || seen.has(`${match[1]}#${match[2]}`)) continue
      rows.push({ gid: match[1], uid: match[2], name: String(profile?.name || match[2]), profile })
    }
    return rows
  }

  return {
    targets,
    list,
    of,
    put(gid, uid, profile, evidenceCount, { sourceFingerprint = '' } = {}) {
      const next = validate(state)
      const key = keyOf(gid, uid)
      const old = next.profiles[key] || null
      const merged = mergeProfile(old || {}, profile)
      const incomingCount = Math.max(Number(evidenceCount) || 0, typeof profile?.samples === 'number' ? profile.samples : 0)
      const previousCount = Number(old && (old.evidenceCount != null ? old.evidenceCount : (typeof old.samples === 'number' ? old.samples : 0))) || 0
      next.profiles[key] = {
        ...merged,
        evidenceCount: Math.max(previousCount, incomingCount),
        updatedAt: Date.now(),
        sourceRev: (Number(next.rev) || 0) + 1,
        sourceFingerprint: sourceFingerprint || undefined,
      }
      save(next)
      return next.profiles[key]
    },
    addTarget({ gid, uid, name }) {
      const g = String(gid || '').replace(/\D/g, '')
      const u = String(uid || '').replace(/\D/g, '')
      if (!g || !u) return { ok: false, message: '群号和 QQ 号都要填' }
      if (state.targets.some((target) => String(target.gid) === g && String(target.uid) === u)) return { ok: false, message: '这个群里的这个人已经在学了' }
      const next = validate(state)
      next.targets.push({ gid: g, uid: u, name: String(name || '').slice(0, 20) })
      save(next)
      return { ok: true, message: '加上了，下次整理记忆时开始学他的说话样子' }
    },
    removeTarget(gid, uid) {
      const g = String(gid || ''), u = String(uid || '')
      const next = validate(state)
      const before = next.targets.length
      next.targets = next.targets.filter((target) => !(String(target.gid) === g && String(target.uid) === u))
      if (next.targets.length === before) return { ok: false, message: '没找到这个目标' }
      delete next.profiles[keyOf(g, u)]
      save(next)
      return { ok: true, message: '不学了，学到的东西也一起清掉了' }
    },
    health: () => ({ ok: true, rev: state.rev }),
  }
}
