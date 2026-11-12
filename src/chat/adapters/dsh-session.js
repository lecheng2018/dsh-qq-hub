// M3-B · DSH Session Adapter：SessionRegistry 的真实 DSH 实现注入点
//
// 适配 DSH 的 sessionController（create/resolveAgent，见 test/helpers/fake-dsh.js 的形状）。
// preset/workspace 语义保持 DSH 原样：按聊天域选 preset（private=主人预设 / group=social 预设，
// 由调用方经 presetOf 注入，本适配器不硬编码业务规则）；workspaceId 由调用方经 ensureWorkspace 注入。

/**
 * @param {object} o
 * @param {object} o.dsh DSH 插件上下文（含 services.sessionController）
 * @param {(chatKey: string) => { agentPreset: string }} o.presetOf 聊天 → preset
 * @param {(chatKey: string) => {id:string}|undefined} [o.ensureWorkspace] 按聊天返回工作区对象（真机报告 5：建会话必须带
 *   workspaceId，否则落到宿主 defaultCwd，turn/start 立刻 error）。缺失/抛错则按 defaultCwd 建会话（如实降级）。
 * @param {(chatKey: string) => string|Promise<string>} [o.titleOf] 会话标题（真机报告 9：不命名则面板全是
 *   「未命名」；legacy hub.js:327 建会话后立刻 rename）。可以是 async（群名要查网关）。
 */
export function createDshSessionAdapter({ dsh, presetOf, ensureWorkspace, titleOf }) {
  if (!dsh) throw new TypeError('dsh 必填')
  if (typeof presetOf !== 'function') throw new TypeError('presetOf 必填')
  // cordis 的 dsh.services 是「未声明 inject 直接点会抛」的 getter（真机报告 3）；只走 ctx.get，try/catch 兜住
  const controller = () => {
    try { return dsh?.get?.('sessionController') ?? null } catch { return null }
  }

  /** 读当前标题（经 sessionTitle 服务 fold 会话日志）。读不到返回 undefined（老宿主没这个服务）。 */
  async function currentTitle(ctrl, sessionId) {
    try {
      const r = await ctrl?.resolveAgent?.(sessionId)
      const session = r?.agent?.session
      if (!session) return undefined
      const svc = (() => { try { return dsh?.get?.('sessionTitle') ?? null } catch { return null } })()
      return svc?.get?.(session)?.title
    } catch { return undefined }
  }

  /** 已命名缓存：DSH 的 rename 同值也会落一条新 session/title 事件，重复回填会刷屏；
   *  进程重启后内存缓存是空的，再用回读当前标题兜一层（跨重启幂等）。 */
  const titled = new Map()
  /** 给会话起名（titleOf 可同步可 async——群名要去网关查；缺省不命名）。失败静默，只是显示问题。 */
  async function renameSession(ctrl, sessionId, chatKey) {
    if (typeof titleOf !== 'function') return
    let title
    try { title = String(await titleOf(chatKey) || '').trim() } catch { return }
    if (!title) return
    if (titled.get(sessionId) === title) return
    const current = await currentTitle(ctrl, sessionId)
    if (current && current === title) { titled.set(sessionId, title); return }
    try {
      await ctrl?.rename?.({ sessionId, title })
      titled.set(sessionId, title)
    } catch { /* 只影响显示 */ }
  }

  return {
    /** 面板/回填用：给已存在的会话补名字。 */
    renameExisting: async (sessionId, chatKey) => renameSession(controller(), sessionId, chatKey),
    /** SessionRegistry.createSession 注入点签名。 */
    async createSession(chatKey, hint = {}) {
      const ctrl = controller()
      if (!ctrl?.create) throw new Error('DSH 没有 sessionController.create（适配失败，fail-closed）')
      const { agentPreset, workspaceId: presetWs } = { ...presetOf(chatKey), ...hint }
      let workspaceId = presetWs
      if (!workspaceId && typeof ensureWorkspace === 'function') {
        try { workspaceId = (await ensureWorkspace(chatKey))?.id } catch { workspaceId = undefined }
      }
      const created = await ctrl.create({ ...(workspaceId ? { workspaceId } : {}), agentPreset })
      if (!created?.sessionId) throw new Error('DSH 创建会话未返回 sessionId')
      const sessionId = String(created.sessionId)
      // [修复] 新核心建完会话不命名 → 面板里全是「未命名」。legacy 建会话后立刻 rename（hub.js:327），
      // 这里补上同一动作；命名失败只影响显示，绝不让建会话失败。
      await renameSession(ctrl, sessionId, chatKey)
      return { sessionId, agentPreset: created.agentPreset ? String(created.agentPreset) : undefined }
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
