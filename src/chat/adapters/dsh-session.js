// M3-B · DSH Session Adapter：SessionRegistry 的真实 DSH 实现注入点
//
// 适配 DSH 的 services.sessionController（create/resolveAgent，见 test/helpers/fake-dsh.js 的形状）。
// preset/workspace 语义保持 DSH 原样：按聊天域选 preset（private=主人预设 / group=social 预设，
// 由调用方经 presetOf 注入，本适配器不硬编码业务规则）；workspaceId 同理透传。

/**
 * @param {object} o
 * @param {object} o.dsh DSH 插件上下文（含 services.sessionController）
 * @param {(chatKey: string) => { agentPreset: string, workspaceId?: string }} o.presetOf 聊天 → preset/workspace
 */
export function createDshSessionAdapter({ dsh, presetOf }) {
  if (!dsh) throw new TypeError('dsh 必填')
  if (typeof presetOf !== 'function') throw new TypeError('presetOf 必填')
  const controller = () => dsh?.services?.sessionController ?? dsh?.get?.('sessionController')

  return {
    /** SessionRegistry.createSession 注入点签名。 */
    async createSession(chatKey, hint = {}) {
      const ctrl = controller()
      if (!ctrl?.create) throw new Error('DSH 没有 sessionController.create（适配失败，fail-closed）')
      const { agentPreset, workspaceId } = { ...presetOf(chatKey), ...hint }
      const created = await ctrl.create({ workspaceId, agentPreset })
      if (!created?.sessionId) throw new Error('DSH 创建会话未返回 sessionId')
      return { sessionId: String(created.sessionId), agentPreset: created.agentPreset ? String(created.agentPreset) : undefined }
    },
    /** 会话是否真实存在（回读校验，M3-B 验收）。 */
    async resolveAgent(sessionId) {
      const ctrl = controller()
      if (!ctrl?.resolveAgent) return { ok: false, reason: 'DSH 没有 sessionController.resolveAgent' }
      const r = await ctrl.resolveAgent(sessionId)
      return r?.agent ? { ok: true } : { ok: false, reason: String(r?.error?.code || 'not-found') }
    },
  }
}
