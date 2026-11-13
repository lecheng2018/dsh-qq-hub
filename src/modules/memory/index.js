// 内置模块：记忆。她自己记下值得记的事、聊天时想起相关的、每天把聊天流水整理进长期记忆，还有每个人的小档案、相处经验、说话方式。
// 导出 createMemoryStore 的返回值：add / addEvent / recall / list / contextFor / topicScore / consolidate ……
// 别的模块（空间日记、B 站）会往这里记她的经历；记忆模块关着时它们自己跳过。

import { createMemoryStore, memoryLine } from '../../features/memory.js'
import { createMemoryBus } from '../../features/memory-bus.js'
import { currentPersonaText } from '../../persona/personas.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'memory',
  name: '记忆',
  version: '1.0.0',
  description: '长期记忆：记事、想起、每日整理、小档案和相处经验',
  tab: 'memory',
  files: ['features/memory.js', 'features/memory-archive.js', 'features/memory-learning.js', 'features/memory-extractor.js'],
  provides: ['memory-store'], // 伴生模块经 api.use('memory') 读记忆（SDK 能力声明）
  setup(api) {
    const { hub, http } = api.core
    const memory = createMemoryStore({
      dsh: api.dsh, getConfig: api.config, hub, chatLog: api.core.chatLog, log: api.log,
      personaText: () => currentPersonaText(api.config().persona.current),
      reflectionContext: false,
      styleContext: false,
      reflectImpl: (chat, transcript, genSignal) => {
        try { return api.use('reflection')?.reflect(chat, transcript, genSignal) || 0 } catch { return 0 }
      },
      styleImpl: (genSignal) => {
        try { return api.use('style')?.learnSelfStyle(genSignal) } catch { return undefined }
      },
    })

    api.context(({ chat, sessionId }) => (chat.kind === 'system' ? '' : memory.contextFor(chat, sessionId)))
    // #79：随消息变化的相关记忆放在「交给她的内容」里，不放进每轮都会追加的运行时上下文快照
    api.on('prompt', (content, info) => {
      try {
        if (!info || !info.chat || info.chat.kind === 'system' || !Array.isArray(content)) return content
        const hint = memory.recallHint(info.chat, info.queryText || '', info.prevText || '', { sessionId: info.sessionId })
        if (!hint) return content
        return [{ type: 'text', text: hint }, ...content]
      } catch (error) { return content }
    })
    // 召回负反馈：用户说「记错了」，90 秒内注入过的记忆降权（BM25 检索补不上的反馈环）
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'in' || !a.text) return
        memory.reportMiss(a.chatId, a.text)
      } catch (error) {}
    })
    api.every(60_000, () => memory.tick(), '整理记忆')

    api.tool(({ chat }) => {
      if (!api.config().memory.enabled || chat.kind === 'system') return []
      const current = chat.chatId
      return [
        defineTool({
          name: 'remember',
          description: '把一件值得长期记住的事记下来（对方的名字、喜好、约定、重要的事）。一条只记一件事；日常琐事不用记；记的时候安静地记，别在回复里说「我记住了」。',
          properties: {
            text: str('要记住的事，一句话，主语写清楚'),
            about: str('这件事是关于谁的（名字），可选'),
            importance: { type: 'number', description: '0~1，约定、关系、核心喜好写高一点，随口一提写低一点，不确定写 0.5' },
          },
          required: ['text'],
          execute: async ({ text, about, importance }) => {
            const activeMem = api.use('memory')?.store || globalThis.qqHub?.modules?.use('memory')?.store || memory
            return activeMem.add({
              text,
              aboutName: about || '',
              about: chat.kind === 'private' ? chat.userId : '',
              importance: importance ?? 0.5,
              source: 'tool',
              chatId: current,
              // 私聊记的只在这个私聊可见，群里记的只在这个群可见（global 才到处可见）。
              // 不这样打标，私聊说的「我的猫叫粥粥」会在群里被检索出来 —— 记忆隔离就形同虚设。
              scope: activeMem.scopeOfChat(chat),
            })
          },
        }),
        defineTool({
          name: 'recall_memory',
          description: '翻一翻记忆库：想不起对方以前说过什么、喜欢什么、约过什么时用。query 写关键词或一句话。',
          properties: { query: str('想找什么') },
          required: ['query'],
          execute: async ({ query }) => {
            // chat 一定要传：不传就跨作用域召回，群里能把私聊记的事翻出来
            const activeMem = api.use('memory')?.store || globalThis.qqHub?.modules?.use('memory')?.store || memory
            const hits = activeMem.recall(String(query || ''), { about: chat.userId, limit: 8, where: current + '（翻记忆）', chat })
            return hits.length ? { ok: true, message: hits.map((h) => memoryLine(h.it)).join('；') } : { ok: true, message: '没想起相关的事' }
          },
        }),
      ]
    })

    api.route('/memories', async (req) => ({ ok: true, items: memory.list(http.query(req).q || '').slice(0, 300), stats: memory.stats(), health: memory.health() }))
    api.route('/memory/reload', async (req) => {
      if (req.method !== 'POST') return { ok: false, message: '请使用 POST 重新载入档案' }
      return memory.reload()
    })
    api.route('/memory/batches', async () => ({ ok: true, batches: memory.extractionBatches() }))
    api.route('/memory/batches/resolve', async (req) => {
      if (req.method !== 'POST') return { ok: false, message: '请使用 POST 恢复提炼批次' }
      const b = await http.body(req)
      return memory.resolveExtractionBatch(String(b.id || ''), String(b.action || ''))
    })
    api.route('/memory/add', async (req) => {
      const b = await http.body(req)
      return memory.add({ text: b.text, aboutName: b.aboutName || '', about: b.about || '', importance: b.importance ?? 0.6, tags: b.tags || [], source: 'panel' })
    })
    api.route('/memory/update', async (req) => {
      const b = await http.body(req)
      return memory.update(b.id, b)
    })
    api.route('/memory/delete', async (req) => {
      const b = await http.body(req)
      return memory.remove(b.id)
    })
    // 主人换号迁移：旧号名下的私聊记忆整体搬到新号（scope/about 一起改）
    api.route('/memory/reassign-owner', async (req) => {
      const b = await http.body(req)
      return memory.reassignOwner(b.from, b.to)
    })
    api.route('/insights', async () => ({ ok: true, items: memory.insights(), styles: memory.styles() }))
    api.route('/memory/recalls', async () => ({ ok: true, list: memory.recalls() }))
    api.route('/memory/restore', async (req) => memory.restore((await http.body(req)).id))
    api.route('/profiles', async () => ({ ok: true, list: memory.profiles() }))
    api.route('/profiles/save', async (req) => {
      const b = await http.body(req)
      memory.setProfile(String(b.qq || ''), String(b.text || ''), '', String(b.scope || ''))
      return { ok: true, message: b.text ? '小档案已保存' : '小档案已清空' }
    })
    api.route('/profiles/rebuild', async (req) => {
      const b = await http.body(req)
      try {
        return (await memory.buildProfile(String(b.qq || ''), String(b.scope || ''))) ? { ok: true, message: '按记忆重写好了' } : { ok: false, message: '关于 TA 的记忆还太少（至少 3 条）' }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })
    api.route('/memory/import', async (req) => {
      const b = await http.body(req)
      try { return { ok: true, list: await memory.importCandidates(String(b.text || '').slice(0, 30000)) } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/memory/import/commit', async (req) => {
      const b = await http.body(req)
      const n = memory.importCommit(b.items || [], { scope: b.scope === 'global' ? 'global' : 'private' })
      return { ok: true, message: `存进记忆库 ${n} 条${b.scope === 'global' ? '（所有聊天可见）' : ''}` }
    })
    api.route('/style/save', async (req) => {
      const b = await http.body(req)
      memory.setStyle(String(b.key || ''), (b.list || []).map((t) => String(t).trim()).filter(Boolean))
      return { ok: true, message: '说话方式已保存' }
    })
    api.route('/insights/save', async (req) => {
      const b = await http.body(req)
      memory.setInsights(String(b.key || ''), (b.list || []).map((t) => String(t).trim()).filter(Boolean))
      return { ok: true, message: '相处经验已保存' }
    })
    // 单条删除（2026-11-04 面板只有「保存/按记忆重写」，删不掉单条）
    api.route('/insights/delete', async (req) => {
      const b = await http.body(req)
      const ok = memory.removeInsight(String(b.key || ''), String(b.id || ''))
      return ok ? { ok: true, message: '这条相处经验已删除' } : { ok: false, message: '没找到这条记录（可能已被删过）' }
    })
    api.route('/profiles/delete', async (req) => {
      const b = await http.body(req)
      memory.removeProfile(String(b.qq || ''), String(b.scope || ''))
      return { ok: true, message: '小档案已删除' }
    })
    api.route('/memory/extract', async (req) => {
      const b = await http.body(req)
      // 共享流水只读消费，整理进度由记忆模块独立记录。
      return memory.consolidate({ includeToday: b.includeToday !== false })
    })

    // 记忆总线（1.3.48）：模块返回值在主库之上叠一层总线。其他模块拿到的
    // api.use('memory') 从此是总线——add/addEvent/recall/listFor/recentEventsFor
    // 都收拢到统一入口；面板路由继续直接调 store 的管理接口（list/remove/insights…）。
    const bus = createMemoryBus({ store: memory, log: api.log })

    return Object.assign(Object.create(memory), bus, {
      /** 底下那层主库：面板统计、consolidate、小档案这类管理接口还在它身上 */
      store: memory,
    })
  },
}
