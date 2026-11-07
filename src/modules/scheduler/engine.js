// 调度任务执行引擎：管理任务列表、持久化、轮询触发

import fs from 'node:fs'
import path from 'node:path'
import { nextOccurrence } from './schedule.js'

export function createSchedulerEngine({ file, log, tz = 'Asia/Shanghai' } = {}) {
  let tasks = []
  let nextId = 1

  function load() {
    if (!file) return
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        tasks = Array.isArray(raw.tasks) ? raw.tasks : []
        nextId = Number(raw.nextId) || (tasks.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1)
      }
    } catch (err) {
      log?.warn?.('[scheduler] 载入任务失败:', err.message)
    }
  }

  function save() {
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, nextId, tasks }, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      log?.warn?.('[scheduler] 保存任务失败:', err.message)
    }
  }

  load()

  function refreshNext(task, afterMs = Date.now()) {
    task.nextRunAt = nextOccurrence(task.schedule, afterMs, { tz })
    return task.nextRunAt
  }

  // 初始化所有启用的任务下一次时刻
  const now = Date.now()
  for (const t of tasks) {
    if (t.enabled && (!t.nextRunAt || t.nextRunAt <= now)) {
      refreshNext(t, now)
    }
  }

  /**
   * 添加任务
   * @param {object} t 任务对象 { text, target, schedule, enabled?: boolean }
   */
  function add(t) {
    const id = nextId++
    const task = {
      id,
      text: String(t.text || '').trim(),
      target: t.target || 'owner', // 'owner' 或特定 chatId
      schedule: t.schedule,
      enabled: t.enabled !== false,
      createdAt: Date.now(),
      runCount: 0,
      nextRunAt: null,
    }
    refreshNext(task, Date.now())
    tasks.push(task)
    save()
    return task
  }

  function remove(id) {
    const idx = tasks.findIndex((t) => t.id === Number(id))
    if (idx < 0) return false
    tasks.splice(idx, 1)
    save()
    return true
  }

  function toggle(id, enabled) {
    const t = tasks.find((item) => item.id === Number(id))
    if (!t) return false
    t.enabled = Boolean(enabled)
    if (t.enabled) {
      refreshNext(t, Date.now())
    } else {
      t.nextRunAt = null
    }
    save()
    return true
  }

  function list() {
    return tasks.map((t) => ({ ...t }))
  }

  /**
   * 检查到期任务并触发回调
   * @param {number} currentTime
   * @param {(task: object) => Promise<void>} onExecute
   */
  async function tick(currentTime = Date.now(), onExecute) {
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i]
      if (!t.enabled || !t.nextRunAt) continue

      if (currentTime >= t.nextRunAt) {
        t.runCount = (t.runCount || 0) + 1
        t.lastRunAt = currentTime

        try {
          if (typeof onExecute === 'function') {
            await onExecute(t)
          }
        } catch (err) {
          log?.warn?.(`[scheduler] 任务 #${t.id} 执行失败:`, err.message)
        }

        // 重新计算下一次执行时间
        refreshNext(t, currentTime)

        // 一次性任务若无下一次时间，自动标记完成
        if (t.schedule?.type === 'once' && !t.nextRunAt) {
          t.enabled = false
        }

        save()
      }
    }
  }

  return {
    add,
    remove,
    toggle,
    list,
    tick,
    get: (id) => tasks.find((t) => t.id === Number(id)),
    count: () => tasks.length,
  }
}
