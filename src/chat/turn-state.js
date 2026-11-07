// M2-C · Turn 状态：回合记录的构造与合法迁移（纯数据层，冻结契约见 ADR-0001 §3）
//
// 状态机：pending → merging → running → succeeded | failed | cancelled
//         （pending = 已定要执行、排队等聊天空闲；merging = 合流窗口收成员）
// 合法迁移之外的赋值直接抛 TypeError——回合状态只有一个 owner（TurnController）。

import { CONTRACT_VERSION, parseChatKey } from '../kernel/modular-contracts.js'

export const TURN_STATES = Object.freeze(['pending', 'merging', 'running', 'succeeded', 'failed', 'cancelled'])

/** 合法迁移表：键 = 当前态，值 = 允许迁往的态集合。 */
const TRANSITIONS = Object.freeze({
  pending: new Set(['merging', 'running', 'cancelled']),
  merging: new Set(['pending', 'running', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
})

let seq = 0

/** 构造一个回合记录（冻结契约字段 + controller 私有扩展放 _ 下划线命名空间外）。 */
export function createTurn({ chatKey, memberEventId, createdAt, kind }) {
  parseChatKey(chatKey)
  if (!memberEventId) throw new TypeError('回合至少要有一个成员事件')
  return {
    contractVersion: CONTRACT_VERSION,
    turnId: `turn-${Date.now().toString(36)}-${++seq}`,
    chatKey,
    kind: kind === 'group' ? 'group' : 'private',
    memberEventIds: [String(memberEventId)],
    members: [null], // 与 memberEventIds 对齐：成员的原始 inbound（仅 controller 内可见）
    state: 'merging',
    createdAt: Number(createdAt) || Date.now(),
    completedAt: undefined,
    error: undefined,
    cancelRequestedAt: undefined,
    steerCount: 0,
  }
}

/** 迁移状态（非法迁移抛 TypeError）。 */
export function setTurnState(turn, next) {
  if (!TURN_STATES.includes(next)) throw new TypeError(`未知 Turn state：${next}`)
  if (!TRANSITIONS[turn.state]?.has(next)) {
    throw new TypeError(`非法状态迁移：${turn.state} → ${next}`)
  }
  turn.state = next
  if (next === 'succeeded' || next === 'failed' || next === 'cancelled') {
    turn.completedAt = Date.now()
  }
  return turn
}

/** 追加成员事件（merging 态专属；去重）。 */
export function addMember(turn, inbound) {
  if (turn.state !== 'merging') throw new TypeError(`merging 态才能收成员（当前 ${turn.state}）`)
  const id = String(inbound.eventId)
  if (turn.memberEventIds.includes(id)) return false
  turn.memberEventIds.push(id)
  turn.members.push(inbound)
  return true
}

/** running 态的转向成员（onSteer 专用；去重同 addMember）。 */
export function addSteerMember(turn, inbound) {
  if (turn.state !== 'running') throw new TypeError(`running 态才能收转向成员（当前 ${turn.state}）`)
  const id = String(inbound.eventId)
  if (turn.memberEventIds.includes(id)) return false
  turn.memberEventIds.push(id)
  turn.members.push(inbound)
  return true
}

/** 是否终态。 */
export function isTerminal(turn) {
  return turn.state === 'succeeded' || turn.state === 'failed' || turn.state === 'cancelled'
}
