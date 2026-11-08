// M3-B · DSH Session Adapter：SessionRegistry 的真实 DSH 实现注入点
//
// 适配 DSH 的 sessionController（create/resolveAgent，见 test/helpers/fake-dsh.js 的形状）。
// preset/workspace 语义保持 DSH 原样：按聊天域选 preset（private=主人预设 / group=social 预设，
// 由调用方经 presetOf 注入，本适配器不硬编码业务规则）；workspaceId 由调用方经 ensureWorkspace 注入。

/**
 * @param {object} o
 * @param {object} o.dsh DSH 插件上下文（含 services.sessionController）
 * @param {(chatKey: string) => { agentPreset: string }} o.presetOf 聊天 → preset
 * @param {() => {id:string}|undefined} [o.ensureWorkspace] 返回工作区对象（真机报告 5：建会话必须带
 *   workspaceId，否则落到宿主 defaultCwd，turn/start 立刻 error）。缺失/抛错则按 defaultCwd 建会话（如实降级）。
 */
export function createDshSessionAdapter({ dsh, presetOf, ensureWorkspace }) {
  if (!dsh) throw new TypeError('dsh 必填')
  if (typeof presetOf !== 'function') throw new TypeError('presetOf 必填')
  // cordis 的 dsh.services 是「未声明 inject 直接点会抛」的 getter（真机报告 3）；只走 ctx.get，try/catch 兜住
  const controller = () => {
    try { return dsh?.get?.('sessionController') ?? null } catch { return null }
  }

  return {
    /** SessionRegistry.createSession 注入点签名。 */
    async createSession(chatKey, hint = {}) {
      const ctrl = controller()
      if (!ctrl?.create) throw new Error('DSH 没有 sessionController.create（适配失败，fail-closed）')
      const { agentPreset, workspaceId: presetWs } = { ...presetOf(chatKey), ...hint }
      let workspaceId = presetWs
      if (!workspaceId && typeof ensureWorkspace === 'function') {
        try { workspaceId = (await ensureWorkspace())?.id } catch { workspaceId = undefined }
      }
      const created = await ctrl.create({ ...(workspaceId ? { workspaceId } : {}), agentPreset })
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
