const MOD_STATE = (m) => {
  if (m.safeSkipped) return { cls: 'dim', text: '安全模式，没加载' }
  if (!m.enabled) return { cls: 'dim', text: '关着' }
  if (m.running === 'user' && m.builtin) return { cls: 'mine', text: '用的是你的版本' }
  if (m.running === 'user') return { cls: 'mine', text: '在跑' }
  if (m.running === 'builtin' && m.fallback) return { cls: 'warn', text: '你的版本没加载成功，先用内置的' }
  if (m.running === 'builtin') return { cls: '', text: '在跑' }
  return { cls: 'err', text: m.error ? '没加载成功' : '没在跑' }
}

/** 一个模块一行：开关、状态、报错，能复制来改 / 用回内置的 / 重新加载。 */

export { MOD_STATE }
