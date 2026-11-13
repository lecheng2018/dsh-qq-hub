// 挂起线索拓扑（计划书 v3.4）：active → extended → dormant。
// US-020 只消费这张表，不持有任何状态；实际落盘由注入的 thread-ledger 负责。
//
// 与 US-004 `thread-ledger.js` 的四态 `['active','extended','dormant','resolved']` 的关系：
//   `resolved` 是**终态**，只由显式 resolve() 进入，不在「未顺承自动推进」这条链路上。
//   所以这里把它拆成独立常量 `CLOSED_STATES`，而不是硬塞进 THREAD_STATES：
//     - THREAD_STATES：本模块负责推进的三态拓扑（既有断言已锁死这三态）；
//     - CLOSED_STATES：账本侧的闭环终态，只被 isClosed() 读，不参与推进。
//   nextThreadState('resolved') 恒为 null，闭环判定见 inner-thread-link.js 的 isClosed()。
export const THREAD_STATES = ['active', 'extended', 'dormant']

/** 账本终态（US-004 四态比本模块多这一个）；只读判定用，绝不参与自动推进。 */
export const CLOSED_STATES = ['resolved']

const NEXT = new Map([
  ['active', 'extended'],
  ['extended', 'dormant'],
  ['dormant', null],
  ['resolved', null],
])

/** 推进一格；终态 / 未知状态返回 null（fail-closed）。 */
export function nextThreadState(state) {
  if (typeof state !== 'string') return null
  if (!NEXT.has(state)) return null
  return NEXT.get(state)
}
