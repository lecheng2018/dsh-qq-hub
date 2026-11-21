// 空间日记的配图：优先用今天她自己画的图，其次用今天收进表情库的表情包。
// 只从本机数据目录里挑，不接受外部输入；找不到就返回空串（日记照常只发文字）。

import { listPaintings, paintingPath } from './paintings.js'
import { loadLibrary, stickerPath } from './stickers.js'

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** 这个 from 是不是「某个会话」——表情条目的 from 对采集来的就是来源 chatId。 */
const isChatSource = (from) => /^(private|group):\d+$/.test(String(from || ''))

/**
 * 给一篇日记挑一张配图（本地文件路径）；没有合适的返回 ''。
 *
 * 审计 S07：表情库里的表情大多是**从别人会话里收集**的（item.from 就是来源
 * chatId，实盘 230 条里 197 条是 group:*），过去只按日期挑选、不看来源，
 * 于是别人在群里发的表情会被配到公开发布的说说上。
 * 现在：她自己的画作永远可用；表情只接受「非会话来源」（自己通过工具/面板存的、
 * 从主人 QQ 收藏导入的）或来源会话在 allowedChats 里的。
 *
 * @param {{now?: Date, allowedChats?: string[]}} [o]
 */
export function pickDiaryImage ({ now = new Date(), allowedChats = [] } = {}) {
  const t0 = startOfDay(now)
  const allow = new Set((Array.isArray(allowedChats) ? allowedChats : []).map((x) => String(x)))
  // 1) 今天她画的图：最新一张（自己画的图最贴合「她今天干了什么」，也没有来源争议）
  try {
    const paintings = listPaintings({ limit: 20 }).items.filter((p) => Number(p.at) >= t0)
    if (paintings.length) {
      const p = paintingPath(paintings[0].file)
      if (p) return p
    }
  } catch (error) {}
  // 2) 今天收进表情库的表情包：最新一张，但要过来源检查
  try {
    const items = loadLibrary().items
      .filter((i) => Number(i.at) >= t0)
      .filter((i) => !isChatSource(i.from) || allow.has(String(i.from)))
    if (items.length) {
      const p = stickerPath(items[items.length - 1])
      if (p) return p
    }
  } catch (error) {}
  return ''
}
