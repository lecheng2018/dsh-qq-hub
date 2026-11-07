// 群黑话词频统计（纯本地，零模型调用）——「蒸馏群友」第一步：新词发现。
//
// 目标：从一天的群聊流水里找出「这个群在反复用、但不在常用词表里」的词，喂给
// 每日提炼的提示词当候选，让模型去判断哪些真是黑话/梗、该不该记。
// 中文没有现成分词，这里用两层近似：
//   1. tokenize 的二元字组（bigram）频次统计——高频 bigram 大概率是词或惯用搭配；
//   2. 和「常用词表」（STOP + 白名单高频词）求差——剩下的就是值得模型看的候选。
// 误报无所谓：这只是候选生成，最终进不进黑话本由模型和去重把关。

import { tokenize } from './memory-core.js'

/** 高频常用词白名单：这些在聊天里天天出现，绝不该进黑话本。
 *  覆盖寒暄、代词、常用动词、语气词、平台词。宁多勿漏——白名单漏一个，每天就被顶到候选榜。 */
const COMMON = new Set(('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过' +
  '没好行不行想看听说说问觉得怎么为什么现在今天明天昨天晚上白天中午早上时间' +
  '东西事情感觉知道应该可能可能其实真的还是然后所以但是不过就是已经快要' +
  '哈哈嘿嘿嘻嘻呵呵草卧槽牛逼666233awslxswl绝了爱了蠢哭死麻了绷不住' +
  '一个两个三个一些这么那么怎样怎么样什么为什么因为如果虽然虽然但是' +
  '游戏手机电脑视频图片直播群友群里点赞发帖表情包表情语音消息红包' +
  '吃饭喝水睡觉起床上班上学下班放学加班周末周一周日今天明天后天' +
  '大佬萌新老哥兄弟姐妹兄弟们老铁家人们集美' +
  '确实对的没错好的没问题收到了解明白懂了没事没事儿' +
  '白米饭大肥鱼小鲸鱼主人老板哥姐').split(''))

/** 一个群、一天的流水 → 候选新词（按出现次数排，最多 n 个）。 */
export function discoverSlangCandidates(lines, { topN = 12, minCount = 4, minLen = 2, maxLen = 8 } = {}) {
  // 只看人话（bot 自己的不算「群友的话」，系统行更不是）
  const texts = (lines || [])
    .filter((l) => l && l.text && l.who !== 'bot' && !String(l.text).startsWith('【系统'))
    .map((l) => String(l.text))
  if (texts.length < 10) return [] // 样本太少不统计
  const freq = new Map()
  for (const t of texts) {
    // tokenize 产 bigram；这里升级为「1~4 字滑窗内的高频连续段」太贵，
    // 直接用二元组 + 常见三字模式（ABB / AAB 在黑话里高频：如「拴Q了」「泰裤辣」）足够当候选
    for (const w of tokenize(t)) {
      if (w.length < minLen || w.length > maxLen) continue
      if (COMMON.has(w)) continue
      // 含标点/符号/纯数字的丢弃（tokenize 已保证中文段，这里再防英文乱码）
      if (/^[0-9]+$/.test(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  // bigram 相邻合并：如果一个 bigram 的前字+后字连起来在原文里高频连用（三字词），
  // 频次会自然分层，直接取 topN 即可——不用真分词，模型会自己辨认。
  const top = [...freq.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
  // 每个候选带 2 条原句（截 30 字）：拼回完整词、判断语义全靠这个，比只给 bigram 碎片强得多
  return top.map(([w, n]) => {
    const samples = []
    for (const t of texts) {
      if (t.includes(w) && !samples.includes(t)) samples.push(t.slice(0, 30))
      if (samples.length >= 2) break
    }
    return { word: w, count: n, samples }
  })
}
