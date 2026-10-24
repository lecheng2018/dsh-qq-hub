// 陪伴类小功能：心情、长期记忆、主动搭话、翻唱（预留）。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'

// ---------------- 心情 ----------------
// 0~100，基线 60。聊天里的话按关键词推一推，随时间按半衰期回到基线。
// 只在变化明显时告诉她，并且每天有上限——每轮都念会把性格念「定」住（dsh-feiyu-mood 踩过的坑）。

const UP = ['喜欢你', '爱你', '想你', '好可爱', '真棒', '厉害', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '乖', '白米饭', '好吃']
const DOWN = ['讨厌', '滚', '烦', '闭嘴', '笨', '傻', '无聊', '走开', '别理我', '不理你', '生气', '难过']

export function moodLabel(v) {
  if (v >= 85) return '超开心'
  if (v >= 70) return '心情不错'
  if (v >= 50) return '平平常常'
  if (v >= 35) return '有点低落'
  return '不太开心'
}

export function scoreText(text) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if (t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

export function decayed(value, at, halfLifeHours, now = Date.now(), base = 60) {
  const h = Math.max(0, (now - at) / 3600_000)
  return base + (value - base) * Math.pow(0.5, h / halfLifeHours)
}

export function createMood({ getConfig }) {
  const file = () => dataDir('mood.json')
  const load = () => readJson(file(), () => ({ value: 65, at: Date.now(), reason: '', told: [], toldValue: 65 }))
  const save = (s) => writeJson(file(), s)
  const current = () => {
    const s = load()
    return Math.round(decayed(s.value, s.at, getConfig().mood.halfLifeHours))
  }
  return {
    current,
    label: () => moodLabel(current()),
    state: () => ({ ...load(), value: current(), label: moodLabel(current()) }),
    observe(text, who) {
      if (!getConfig().mood.enabled) return
      const d = scoreText(text)
      if (!d) return
      const s = load()
      s.value = Math.max(5, Math.min(100, current() + d))
      s.at = Date.now()
      s.reason = `${who || '有人'}说「${String(text).slice(0, 20)}」`
      save(s)
    },
    /** 给系统提示词上下文用：只在和上次告诉她时差得多才说，而且每天有上限。 */
    contextLine() {
      const cfg = getConfig().mood
      if (!cfg.enabled) return ''
      const s = load()
      const v = current()
      if (Math.abs(v - (s.toldValue ?? 65)) < 12) return ''
      const today = new Date().toDateString()
      s.told = (s.told || []).filter((t) => new Date(t).toDateString() === today)
      if (s.told.length >= cfg.maxInjectPerDay) return ''
      s.told.push(Date.now())
      s.toldValue = v
      save(s)
      return `（你现在的心情：${moodLabel(v)}${s.reason ? '，因为' + s.reason : ''}。让它自然地影响语气就好，不用说出来。）`
    },
  }
}

// ---------------- 主动搭话 ----------------

export function createSpeakUp({ getConfig, hub, log, isMuted }) {
  const file = () => dataDir('speakup.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, nextAt: 0, last: 0 }))
  const save = (s) => writeJson(file(), s)

  function schedule(s, cfg) {
    const min = cfg.minIntervalMinutes
    const max = cfg.maxIntervalMinutes
    s.nextAt = Date.now() + (min + Math.random() * (max - min)) * 60_000
  }

  // 私聊里的「最近一次来往」：只看和主人的私聊，群里再热闹也不影响她想你
  const lastPrivateAt = () => Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0)

  // 每次换个由头，免得句句都是「在干嘛」
  const ANGLES = [
    '分享一件你今天（编也行，符合你的人设）遇到的小事或想到的东西',
    '接着你们上次聊的话题，问问后来怎么样了',
    '想起记忆里关于对方的一件事，顺口提一句或关心一下',
    '问问对方现在在干嘛、吃了没、累不累',
    '撒个娇或者吐槽一句，说你有点无聊',
    '随手发个表情包或者一句没头没尾的感慨',
    '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
  ]

  async function fire(reason = '定时', { nudge = false } = {}) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const idle = Math.round((Date.now() - lastPrivateAt()) / 60000)
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}私聊了，想主动找${owner}说点什么。这次的由头可以是：${angle}。用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    await hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: prompt }], '')
  }

  async function tick() {
    const cfg = getConfig()
    const c = cfg.speakUp
    if (!cfg.enabled || !c.enabled) return
    if (isMuted?.(`private:${cfg.ownerQQ}`)) return // 主人在私聊里让她闭嘴了
    const s = load()
    const today = new Date().toDateString()
    if (s.day !== today) Object.assign(s, { day: today, count: 0 })
    if (!s.nextAt) schedule(s, c)
    const h = new Date().getHours()
    const awake = h >= c.awakeFrom && h < c.awakeTo
    const idleOk = Date.now() - lastPrivateAt() > c.idleMinutes * 60_000
    // 追问：她最后一句是在问主人、主人 15~40 分钟没回，有一半的机会轻轻追一句（每句最多追一次，不占每天的次数）
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quiet = Date.now() - lb.at
    if (awake && c.nudge && lb.at > (hub.lastOwnerChatAt || 0) && lb.at !== s.nudgedFor && /[？?]|吗|呢|嘛|没$/.test(lb.text.trim()) && quiet > 15 * 60_000 && quiet < 40 * 60_000) {
      s.nudgedFor = lb.at
      save(s)
      if (Math.random() < 0.5) await fire('追问', { nudge: true })
      return
    }
    if (awake && idleOk && s.count < c.maxPerDay && Date.now() >= s.nextAt) {
      s.count++
      s.last = Date.now()
      schedule(s, c)
      save(s)
      await fire()
      return
    }
    save(s)
  }

  return { tick, fire, state: load }
}

// ---------------- 翻唱（预留） ----------------
// 以后的流水线：点歌 → 下载（网易云）→ 人声分离 → 90 秒切片 RVC 变声 → 混音 → 缓存 → 发回原会话。
// 现在只留接口：面板显示「未启用」，工具返回说明。

export function createSong({ getConfig }) {
  return {
    status: () => ({ enabled: false, ready: false, message: '翻唱还没启用：需要先装 RVC（以后的版本提供）' }),
    async request({ song }) {
      if (!getConfig().song.enabled) return { ok: false, message: `翻唱功能还没开放（想唱的是「${song}」，先记下了）` }
      return { ok: false, message: '翻唱流水线尚未实现' }
    },
  }
}
