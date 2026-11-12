import { askModel } from '../core/llm.js'
import { whenText } from './memory-core.js'

export function createMemoryExtractor({ dsh, getConfig, relatedTo, commit, isActive }) {
  async function extractFacts(chatId, transcript, genSignal = null) {
    if (!isActive()) return 0
    if (genSignal && !genSignal.isValid()) return 0
    const cfg = getConfig()
    const source = chatId === 'qzone' ? '下面是 QQ 空间里的动态（好友发的说说、别人给你的评论、你的回复）' : '下面是一段聊天'
    const related = relatedTo(chatId, transcript)
    const known = new Map(related.map((item) => [item.id, item]))
    let out = ''
    try {
      out = await askModel(dsh, {
        cfg,
        system: `你帮一个叫「大肥鱼」的聊天角色整理长期记忆。${source}，说话人后面括号里是 QQ 号。QQ 号是 ${cfg.ownerQQ} 的人是她的${cfg.ownerName || '主人'}。

记什么（三类）：
1. 人：别人的名字/称呼/身份/关系，喜好和讨厌的东西，雷区和禁忌，近况变化，你们之间的约定。
2. 她自己攒下的经验教训：踩过的坑、验证过的方法、定下的规矩。
3. 从看过的内容里学到的可复用知识：结论 + 适用条件 + 出处（哪个视频、哪篇文章、谁转述的）。这类要记，但要记成能直接用的结论，不是「看过某视频」。

不记：寒暄、日常琐事、一次性问答、没人再提的闲聊；不记她自己的人设和喜好（她本来就知道）；不记「今天看了什么」这种浏览流水，只记从里面学到的东西。

怎么写：
- 一条 30 到 60 字，写成一句自然的话，带一个具体细节（数字、店名、原话片段、命令、路径）。
- 句子本身要说清是谁说的、关于谁，不许用「有人」「群友」「他们」这种模糊主语。别人转述的写清转述关系。
- 不要字段标签（gist=、detail=、why=）、不要小标题、不要分点，就是一句人话。
- 正例：「小明不吃香菜，上次点菜挑了十分钟，点外卖记得问他」
- 正例：「NAS 选盘别碰杂牌混发，企业盘优先，这是 B 站那个搭 RAID 的视频里讲的」
- 反例：「小明.饮食：gist=不吃香菜；detail=挑十分钟；why=点外卖注意」
- 反例：「在B站看了《选硬盘搭RAID建Docker》这个视频」` +
        (related.length ? '\n每条新事实先和「已经记得的事」比一比：全新的写 "op":"add"；是对某条旧记忆的补充或更准确的说法，写 "op":"update"、"id" 填那条的编号、"text" 写合并后的完整说法；和某条旧记忆矛盾、说明那条已经过时（比如以前喜欢现在不喜欢了、换了工作、搬家了、分手了），写 "op":"outdated"、"id" 填旧的编号、"text" 写现在的新事实。拿不准是不是矛盾就当 add；已经记得、没有新信息的不要输出。' : '') +
        `只输出 JSON 数组，例如 [{"op":"add","text":"小明不吃香菜，上次点菜挑了十分钟，点外卖记得问他","about":"小明","about_qq":"12345","importance":0.6,"tags":["口味"]}]，tags 可选、最多两个短词，没有值得记的就输出 []。`,
        text: (related.length ? `已经记得的事：\n${related.map((item) => `#${item.id} [${whenText(item.at)}] ${item.aboutName ? '[' + item.aboutName + '] ' : ''}${item.text}`).join('\n')}\n\n` : '') + transcript,
        maxTokens: 1500,
        temperature: 0.2,
        signal: genSignal?.signal,
      })
    } catch (error) {
      if (genSignal && !genSignal.isValid()) return 0
      throw error
    }
    if (!isActive() || (genSignal && !genSignal.isValid())) return 0
    const match = out.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('模型未返回有效的记忆 JSON 数组')
    let entries
    try { entries = JSON.parse(match[0]) } catch { throw new Error('模型返回的记忆 JSON 数组不合法') }
    if (!Array.isArray(entries)) throw new Error('模型未返回记忆 JSON 数组')
    let added = 0
    try {
      for (const item of entries.slice(0, 12)) {
        if (!item || !item.text) continue
        if (/^(我|大肥鱼)/.test(String(item.about || '')) || String(item.about || '') === '大肥鱼') continue
        const qq = String(item.about_qq ?? '').replace(/\D/g, '')
        const about = qq.length >= 5 && qq !== String(cfg.botQQ) ? qq : chatId.startsWith('private:') ? chatId.slice(8) : ''
        if (await commit(item, { chatId, cfg, known, about })) added++
      }
    } catch (error) {
      error.factsCommitted = added
      throw error
    }
    return added
  }

  return { extractFacts }
}
