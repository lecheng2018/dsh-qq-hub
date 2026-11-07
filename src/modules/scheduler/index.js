// 通用定时任务与自动化调度模块（移植自 dsh-qq 的 scheduler 引擎）
//
// 1. 支持丰富的定时模式：指定时间 once、相对延时 in 30m、每日 daily、工作日 workdays、每周 weekly、Cron；
// 2. QQ 原生交互：主人私聊通过 /remind 命令增删改查；
// 3. AI 原生工具：向模型注册 schedule_reminder 工具，AI 可以在对话中主动帮主人定提醒；
// 4. 定时到达时，自动通过 QQ 发送通知卡片。

import { defineTool, str } from '../../tools/tools.js'
import { createSchedulerEngine } from './engine.js'
import { parseRemindCommand, REMIND_HELP } from './commands.js'
import { fmtDate, fmtTime, zonedParts } from './time.js'

export default {
  id: 'scheduler',
  name: '定时任务',
  version: '1.0.0',
  api: 1,
  description: '支持一次性/每日/工作日/每周及Cron定时提醒，支持/remind指令与AI自主登记工具',
  defaults: {
    enabled: true,
    timezone: 'Asia/Shanghai',
  },
  settings: [
    { key: 'enabled', label: '启用定时任务', type: 'switch' },
    { key: 'timezone', label: '调度时区', type: 'text' },
  ],
  setup(api) {
    const tz = api.settings().timezone || 'Asia/Shanghai'
    const engine = createSchedulerEngine({
      file: api.dataDir('tasks.json'),
      tz,
      log: api.log,
    })

    // 定时轮询（每 10 秒检查一次是否有到期任务）
    api.every(10_000, async () => {
      if (api.settings().enabled === false) return
      const now = Date.now()
      await engine.tick(now, async (task) => {
        const owner = api.config().ownerQQ
        const target = task.target === 'owner' ? `private:${owner}` : task.target
        if (!target) return

        const card = [
          `⏰【定时提醒 #${task.id}】`,
          `${task.text}`,
        ].join('\n')

        api.log.info(`[scheduler] 触发任务 #${task.id} → ${target}`)
        await api.sendText(target, card)
      })
    }, '定时任务检查')

    // QQ 管理员指令 /remind
    api.command({
      name: 'remind',
      aliases: ['提醒', '定时'],
      desc: '定时任务管理',
      async run(arg, msg) {
        if (!api.isOwner(msg.userId)) {
          return '只有主人可以使用定时任务功能。'
        }

        const cmd = parseRemindCommand(`/${msg.text}`, { now: Date.now(), tz })
        if (!cmd) return REMIND_HELP
        if (cmd.error) return `⚠️ ${cmd.error}`
        if (cmd.action === 'help') return REMIND_HELP

        if (cmd.action === 'list') {
          const list = engine.list()
          if (!list.length) return '当前没有设置任何定时任务。发 /remind 查看使用说明。'
          const lines = ['⏰ 当前定时任务列表：']
          for (const t of list) {
            const status = t.enabled ? '🟢' : '⚪ (暂停)'
            let timeDesc = ''
            if (t.nextRunAt) {
              const p = zonedParts(t.nextRunAt, tz)
              timeDesc = `下次：${fmtDate(p)} ${fmtTime(p)}`
            } else {
              timeDesc = '已完成'
            }
            lines.push(`${status} #${t.id} ${t.text} (${timeDesc})`)
          }
          return lines.join('\n')
        }

        if (cmd.action === 'delete') {
          const ok = engine.remove(cmd.id)
          return ok ? `✅ 已删除任务 #${cmd.id}` : `⚠️ 未找到任务 #${cmd.id}`
        }

        if (cmd.action === 'on') {
          const ok = engine.toggle(cmd.id, true)
          return ok ? `✅ 已启用任务 #${cmd.id}` : `⚠️ 未找到任务 #${cmd.id}`
        }

        if (cmd.action === 'off') {
          const ok = engine.toggle(cmd.id, false)
          return ok ? `⚪ 已暂停任务 #${cmd.id}` : `⚠️ 未找到任务 #${cmd.id}`
        }

        if (cmd.action === 'add') {
          const target = msg.kind === 'group' ? msg.chatId : 'owner'
          const t = engine.add({
            ...cmd.task,
            target,
          })
          let nextTimeStr = ''
          if (t.nextRunAt) {
            const p = zonedParts(t.nextRunAt, tz)
            nextTimeStr = `（预计执行时间：${fmtDate(p)} ${fmtTime(p)}）`
          }
          return `✅ 定时任务已创建 #${t.id}：${t.text} ${nextTimeStr}`
        }

        return REMIND_HELP
      },
    })

    // AI 自主登记定时任务工具
    // 注意：这里必须用 defineTool(...) 或返回它的函数，不能直接传裸对象。
    // 直接传对象会被当成「原生 tool 定义」校验，框架会要求 output { schema, render, presentationMeta? }，
    // 于是报错：tool "schedule_reminder" must declare output —— 就是这个原因以前一直挂不上。
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return [defineTool({
        name: 'schedule_reminder',
        description: '为用户设置一个未来的定时提醒或任务。当到达设定时间时，系统会自动在 QQ 发送消息提醒用户。',
        properties: {
          text: str('提醒的内容，例如"喝水"、"检查周报"、"服务器维护"'),
          type: str('调度类型：in(多少分钟/小时后)、once(指定日期时间)、daily(每天)、workdays(工作日)'),
          delay: str('当 type 为 in 时必填，如 30m、2h、1d'),
          date: str('当 type 为 once 时必填，格式 YYYY-MM-DD'),
          time: str('时间 HH:mm，如 09:30 或 18:00'),
        },
        required: ['text', 'type'],
        execute: async ({ text, type, delay, date, time }, exec) => {
        let schedule
        const now = Date.now()
        if (type === 'in') {
          const d = /^(\d+)(m|h|d)$/i.exec(String(delay || '').trim())
          if (!d) return { ok: false, message: 'delay 参数错误，格式为 30m / 2h / 1d' }
          const ms = Number(d[1]) * (d[2].toLowerCase() === 'm' ? 60_000 : d[2].toLowerCase() === 'h' ? 3600_000 : 86400_000)
          const p = zonedParts(now + ms, tz)
          schedule = { type: 'once', date: fmtDate(p), time: fmtTime(p) }
        } else if (type === 'once') {
          if (!date || !time) return { ok: false, message: '一次性任务需要提供 date 和 time' }
          schedule = { type: 'once', date, time }
        } else if (type === 'daily' || type === 'workdays') {
          if (!time) return { ok: false, message: '周期任务需要提供 time (HH:mm)' }
          schedule = { type, times: [time] }
        } else {
          return { ok: false, message: '不支持的调度类型' }
        }

        const sid = exec.agent?.session?.id || ''
        const chatId = api.core.hub.chatOfSession(sid) || 'owner'
        const t = engine.add({ text, schedule, target: chatId })
        let nextDesc = ''
        if (t.nextRunAt) {
          const p = zonedParts(t.nextRunAt, tz)
          nextDesc = `${fmtDate(p)} ${fmtTime(p)}`
        }
        return { ok: true, taskId: t.id, message: `已成功创建提醒 #${t.id}，下一次触发时刻为：${nextDesc}` }
        },
      })]
    })

    // 面板 API 路由
    api.route('/scheduler/list', async () => ({ ok: true, tasks: engine.list() }))
    api.route('/scheduler/del', async (req) => {
      const { id } = await api.core.http.body(req)
      return { ok: engine.remove(id) }
    })

    return {
      engine,
      list: () => engine.list(),
      add: (t) => engine.add(t),
      remove: (id) => engine.remove(id),
    }
  },
}
