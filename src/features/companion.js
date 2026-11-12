// 陪伴类小功能：主动搭话。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence } from '../chat/reply.js'

// ---------------- 主动搭话 ----------------


/**
 * 现在该不该发早安/晚安（纯函数，方便测）。
 *
 * 规则：到点后一个小时内发一次，每天每种只发一次；已经聊过天就不打扰
 * （主人 10 分钟内说过话，说明人已经醒了/还在，不用专门问候）。
 * @param {object} cfg 完整配置
 * @param {object} state speakup.json 状态（含 greeted: { morning: 'date' }）
 * @param {number} [now]
 * @param {number} [lastOwnerAt] 主人最近一次说话的时间戳
 * @returns {{kind:'morning'|'night', at:string}|null}
 */
export function greetingDue(cfg, state, now = Date.now(), lastOwnerAt = 0) {
  const g = (cfg && cfg.speakUp && cfg.speakUp.greeting) || {}
  if (g.enabled === false) return null
  const morning = String(g.morning || '08:00')
  const night = String(g.night || '23:00')
  const d = new Date(now)
  const today = d.toDateString()
  const mins = d.getHours() * 60 + d.getMinutes()
  const parse = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  // 主人刚说过话（10 分钟内）：说明人在，不用专门问候
  if (lastOwnerAt && now - lastOwnerAt < 10 * 60_000) return null
  const greeted = (state && state.greeted) || {}
  const win = 60 // 到点后一小时内有效
  const mm = parse(morning)
  if (mm !== null && mins >= mm && mins < mm + win && greeted.morning !== today) {
    return { kind: 'morning', at: morning }
  }
  const nn = parse(night)
  if (nn !== null && mins >= nn && mins < nn + win && greeted.night !== today) {
    return { kind: 'night', at: night }
  }
  return null
}

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

  async function fire(reason = '定时', { nudge = false, greeting = '' } = {}) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const idle = Math.round((Date.now() - lastPrivateAt()) / 60000)
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const greetPrompt = greeting === 'morning'
      ? `【系统提醒，不是${owner}说的话】现在是早上，跟${owner}说声早。用你自己的口气，一句就够（别问「在吗」、别复述时间），可以顺带一句你今天的状态；不想说就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】现在是该睡的点，跟${owner}道个晚安。用你自己的口气，一句就够，别啰嗦、别说教；对方还在忙就轻轻提一句早点休息。`
    const prompt = greeting ? greetPrompt : nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}私聊了，想主动找${owner}说点什么。这次的由头可以是：${angle}。用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    if (typeof hub.runPromptTurn === 'function') {
      const raw = await hub.runPromptTurn(`private:${cfg.ownerQQ}`, prompt)
      if (!isSilence(raw)) await hub.deliver(`private:${cfg.ownerQQ}`, String(raw), { own: true, userText: prompt })
    } else {
      await hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: prompt }], '')
    }
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
    // 早安 / 晚安：固定时间点，不参与「随机间隔」的抽签。
    // （参考 surfcore 的 greeting-schedule：用户反馈「早上八点的问候没成功」——因为它是纯随机的，
    //   醒来那一刻只有 1/N 的概率撞上。这里改成到点必发一次，且每天只发一次。）
    const greet = greetingDue(cfg, s)
    if (awake && greet) {
      s.greeted = { ...(s.greeted || {}), [greet.kind]: today }
      save(s)
      await fire(greet.kind === 'morning' ? '早安' : '晚安', { greeting: greet.kind })
      return
    }
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
