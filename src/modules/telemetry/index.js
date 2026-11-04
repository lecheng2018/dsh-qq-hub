// 内置模块：上下文与费用遥测（只观察，不改行为）。
//
// 数据源：DSH 的 assistant/message 事件里的 usage 字段（厂商上报的真实用量）。
// 落盘：<dataDir>/telemetry.jsonl，一行一次调用，超 4MB 轮转。
// 面板：本模块只提供一个只读接口，不改任何提示词/工具/闸门。

const ID = 'telemetry'

export default {
  id: ID,
  name: '用量遥测',
  api: 1,
  tab: 'tokenGuardian', // 和「会话压缩」放同一页，都是上下文相关
  description: '记录每次模型调用的 token 与花费（只观察，不改行为）。数据来自 DSH 上报的 usage。',
  defaults: { enabled: true },
  settings: [
    { key: 'enabled', label: '记录用量', type: 'switch', hint: '关掉就完全不写文件。数据只进本地 JSONL，不上传。' },
  ],
  setup(api) {
    /** 最近 N 天汇总（按天 + 按模型）。 */
    api.route('/telemetry/summary', (req) => {
      const days = Math.max(1, Math.min(90, Number(req?.query?.days) || 7))
      const t = api.core.telemetry
      if (!t) return { ok: false, message: '遥测没启用' }
      const s = t.summary({ days })
      return { ok: true, ...s, file: t.fileOf() }
    })
  },
}
