import { createMemoryReflection } from '../../features/memory-reflection.js'
import { currentPersonaText } from '../../persona/personas.js'

export const reflectionModule = {
  id: 'reflection',
  name: '相处经验',
  version: '1.0.0',
  api: 1,
  defaultEnabled: true,
  description: '从近期聊天回顾相处经验；关闭后停止自动回顾与经验注入，不影响事实记忆和手工经验。',
  provides: ['memory-reflection'],
  requires: ['memory-store'],
  tab: 'memory',
  files: ['features/memory-reflection.js'],
  setup(api) {
    const memory = api.use('memory')
    let active = true
    let generation = 1
    const controllers = new Set()

    function createGenerationSignal(timeoutMs = 120000) {
      const controller = new AbortController()
      const current = generation
      controllers.add(controller)
      const timer = setTimeout(() => controller.abort(new Error('回顾任务超时')), timeoutMs)
      timer.unref?.()
      return {
        signal: controller.signal,
        isValid: () => active && generation === current && !controller.signal.aborted,
        cleanup: () => { clearTimeout(timer); controllers.delete(controller) },
      }
    }
    function generationOf(external) {
      const owned = external ? null : createGenerationSignal()
      return { signal: external || owned, cleanup: () => owned?.cleanup() }
    }

    const service = createMemoryReflection({
      dsh: api.dsh,
      getConfig: api.config,
      personaText: () => currentPersonaText(api.config().persona.current),
      log: api.log,
      insightsOf: (key) => memory.insightsOf(key),
      setDerivedInsights: (...args) => memory.setDerivedInsights(...args),
      styleOf: (key) => memory.styleOf(key),
      setStyle: (key, list, { sourceFingerprint }) => api.emit('style/observed', { key, list, sourceFingerprint }),
      createGenerationSignal,
      generationOf,
      isActive: () => active,
    })

    api.context(({ chat }) => {
      if (chat.kind === 'system') return ''
      const key = chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : ''
      const list = key ? memory.insightsOf(key) : []
      if (!list.length) return ''
      const who = chat.kind === 'group' ? '这个群' : '对方'
      return `（和${who}相处的经验，照着做就好，不用说出来：${list.map((item) => item.text).join('；')}）`
    })

    return {
      reflect: (chat, transcript, genSignal) => service.reflect(chat, transcript, genSignal),
      dispose: () => {
        if (!active) return
        active = false
        generation++
        for (const controller of controllers) {
          try { controller.abort(new Error('reflection disposed')) } catch {}
        }
        controllers.clear()
      },
    }
  },
}
