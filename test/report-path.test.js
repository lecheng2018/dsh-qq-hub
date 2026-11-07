// 报告路径（2026-11-05，1.3.48）：「日常聊天活人感、查数据整条排版」是两种输出，
// 判定锚「这一轮在干什么」，不再锚「输出长什么样」。三层信号：
//   第一层 <report> 标记（主信号）：模型显式声明，parseReply 识别后只洗 Markdown 不切段；
//   第二层 工具事件兜底：这一轮调过内容型工具（rss_read、bili_watch…）也按报告处理；
//   第三层 structuredReport 保留：没标记没工具、但输出确实长得像报表，照样整段发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReply } from '../src/chat/reply.js'

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const texts = (raw, rules) => parseReply(raw, { maxChars: 40, maxBubbles: 6, ...rules }).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('第一层：<report> 里的内容整条发出，不按句读拆条', () => {
  const report = '<report>今日 RSS 资讯（5 条）\n\n1. DeepSeek 发布新模型，推理成本降三成\n   来源：机器之心\n2. …\n3. …</report>'
  const out = texts(report)
  assert.equal(out.length, 1, '整段一条：' + JSON.stringify(out))
  assert.match(out[0], /今日 RSS 资讯（5 条）\n\n1\./, '编号和空行排版保留')
})

test('第一层：标记外的话照常分条（开场白归聊天）', () => {
  const raw = '拉好了|||<report>1. A\n2. B</report>'
  const out = texts(raw)
  // 报告体是一条整段；stripMarkdown 会给编号列表补空行（既有显示规则），内容不能丢
  assert.equal(out.length, 2)
  assert.equal(out[0], '拉好了')
  assert.equal(out[1].replace(/\n+/g, '\n'), '1. A\n2. B')
})

test('第一层：忘写闭合标记，从开标记到结尾都算报告', () => {
  const out = texts('<report>1. 资讯一\n2. 资讯二\n3. 资讯三 超过四十个字也没关系，不会被切成两半的，整段走')
  assert.equal(out.length, 1)
})

test('第二层：forceReport 规则下，报告段内部不再被句读拆碎', () => {
  // ||| 是她自己划的气泡边界，照常生效；forceReport 管「这一大段内部不再切」
  const out = texts('拉好了|||一共五条资讯，第一条是啥啥啥，第二条是啥啥啥，第三条比较长也没有标记但整段走', { forceReport: true })
  assert.equal(out.length, 2)
  assert.match(out[1], /一共五条资讯.*整段走/s, '长段整条保留')
})

test('第二层接线：hub 监听 tool/call，turn/end 清掉，记忆工具不算', () => {
  const hub = src('src/chat/hub.js')
  assert.match(hub, /event\.type === 'tool\/call'/)
  assert.match(hub, /CONTENT_TOOLS\.test\(name\)/)
  assert.match(hub, /reportTurns\.delete\(chatId\)/, '只管一轮')
  assert.match(hub, /\/\^\(rss_read\|bili_watch\|heybox_\(feed\|watch\|hot\)\|douyin_\(watch\|recent\|browse\)/)
  assert.ok(!/\|recall_memory\)/.test(hub), '记忆工具不在内容清单里')
  assert.match(hub, /opts\.forceReport \|\| reportTurns\.get\(chatId\)/, '第三处：deliver 的规则注入')
})

test('第三层保留：没标记没工具但输出像报表，structuredReport 照样整段发', () => {
  const report = '【5小时窗口】09:22 开 到 14:22 收 剩 35% 已烧 65%\n还剩 2.7 小时\n【周窗口】剩 93%'
  const out = texts(report)
  assert.equal(out.length, 1, '兜底还在')
  const r = src('src/chat/reply.js')
  assert.match(r, /function structuredReport/, '第三层没删')
})

test('提示词教了 <report> 契约，且日常聊天不用', () => {
  const rules = src('src/persona/personas.js')
  assert.match(rules, /<report>…<\/report>/)
  assert.match(rules, /日常聊天不要用 <report>/)
})
