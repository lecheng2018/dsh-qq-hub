import { createMemoryStyle } from '../../features/memory-style.js'
import { currentPersonaText } from '../../persona/personas.js'

export const styleModule = {
  id: 'style',
  name: '说话方式',
  version: '1.0.0',
  api: 1,
  defaultEnabled: true,
  description: '保存并注入从聊天中学到的说话方式；关闭后停止自动学习与风格上下文，不影响事实记忆。',
  provides: ['memory-style'],
  requires: ['memory-store'],
  tab: 'mood',
  files: ['features/memory-style.js'],
  setup(api) {
    const memory = api.use('memory')
    let active = true
    let generation = 1
    const controllers = new Set()

    function createGenerationSignal(timeoutMs = 120000) {
      const controller = new AbortController()
      const current = generation
      controllers.add(controller)
      const timer = setTimeout(() => controller.abort(new Error('说话方式学习超时')), timeoutMs)
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

    const service = createMemoryStyle({
      dsh: api.dsh,
      getConfig: api.config,
      personaText: () => currentPersonaText(api.config().persona.current),
      log: api.log,
      styles: () => memory.styles(),
      styleOf: (key) => memory.styleOf(key),
      setDerivedStyle: (...args) => memory.setDerivedStyle(...args),
      createGenerationSignal,
      generationOf,
      isActive: () => active,
    })

    api.on('style/observed', ({ key, list, sourceFingerprint }) => {
      if (key && Array.isArray(list) && typeof sourceFingerprint === 'string') service.noteStyle(key, list, sourceFingerprint)
    })

    api.context(({ chat }) => {
      if (chat.kind === 'system') return ''
      const key = chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : ''
      const current = key ? memory.styleOf(key) : []
      const self = memory.styleOf('self')
      if (!current.length && !self.length) return ''
      const learned = current.length ? `和${chat.kind === 'group' ? '这个群' : '对方'}聊久了，${current.join('；')}` : ''
      const own = self.length ? `你平时不知不觉会用的说法：${self.join('、')}` : ''
      return '（说话方式：' + [learned, own].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人；若和人设里的硬性规则（尤其是「绝对禁止」）冲突，完全以人设为准，被禁的写法一条都不要用。）'
    })

    return {
      learnSelfStyle: (genSignal) => service.learnSelfStyle(genSignal),
      dispose: () => {
        if (!active) return
        active = false
        generation++
        for (const controller of controllers) {
          try { controller.abort(new Error('style disposed')) } catch {}
        }
        controllers.clear()
      },
    }
  },
}
