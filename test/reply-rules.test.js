// 分条规则（2026-11-05 二轮）：按字数一刀切会把句子切在半截（时间被拆成「到14」+「22」），
// 而「模型换行就是消息边界」又会把一段排版拆成「4 条极短 + 1 坨巨块」。
// 现在的口径：||| 与空行是硬边界；短行（≤15 字）的换行算她在分行说话；
// 长文排版里的换行不算边界；句子按句末标点攒到「最短条长」才断；条数上限均匀分组。
import test from 'node:test'
import assert from 'node:assert/strict'
import { bubbleLimit, parseReply, replyRules } from '../src/chat/reply.js'

const texts = (raw, rules) => parseReply(raw, rules).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('replyRules：群聊与私聊取不同的单条上限，非法值夹住', () => {
  assert.equal(replyRules({}, true).maxChars, 40, '群聊默认 40')
  assert.equal(replyRules({}, false).maxChars, 120, '私聊默认 120')
  assert.equal(replyRules({ reply: { groupMaxChars: 9999 } }, true).maxChars, 500, '群聊上限夹到 500')
  assert.equal(replyRules({ reply: { privateMaxChars: 1 } }, false).maxChars, 20, '私聊下限夹到 20')
  assert.equal(replyRules({ reply: {} }, true).maxBubbles, 6, '一轮最多 6 条')
  assert.equal(replyRules({ reply: { maxBubbles: 99 } }, true).maxBubbles, 12, '夹到 12')
  assert.equal(replyRules({ reply: { maxBubbles: 0 } }, true).maxBubbles, 1, '至少 1 条')
  assert.equal(replyRules({ reply: {} }, true).keepReports, true, '默认清单整段发')
})

test('按她自己的断句发：她换几行就是几条，不再按字数切碎', () => {
  const raw = '对了 那个我还没说完\n今天挺忙的\n晚上再说吧'
  const out = texts(raw, replyRules({}, true))
  assert.deepEqual(out, ['对了 那个我还没说完', '今天挺忙的', '晚上再说吧'])
})

test('||| 是她自己划的条：内容原样成条', () => {
  const raw = '第一句话在这里|||第二句话也在这一条里，比三十个字长一点也没关系，不用再切'
  const out = texts(raw, replyRules({}, true))
  assert.deepEqual(out, ['第一句话在这里', '第二句话也在这一条里，比三十个字长一点也没关系，不用再切'])
})

test('长文排版：一行一个要点的换行不当消息边界，攒成整条', () => {
  const raw = [
    '刚拉的 11:42 那会儿的数',
    '【5小时窗口】09:22 开 到 14:22 收 剩 35% 已烧 65% 还剩 2.7 小时',
    '【周窗口】09:22 开 到下周三 09:22 剩 93% 已烧 7%',
    '结论没变 周额度基本没动 5小时窗口才是瓶颈',
  ].join(String.fromCharCode(10))
  const out = texts(raw, replyRules({}, true))
  assert.equal(out.length, 1, '长行排版不该被切成一条条：' + JSON.stringify(out))
  assert.ok(out[0].includes('结论没变'), '内容不能丢')
})

test('她分行说话（每行都短）时，换行就是分条', () => {
  const raw = ['在呢', '刚在看你说的那个视频', '确实挺离谱的'].join(String.fromCharCode(10))
  assert.deepEqual(texts(raw, replyRules({}, true)), ['在呢', '刚在看你说的那个视频', '确实挺离谱的'])
})

test('太短的句子不单独成条：攒够最短条长才断', () => {
  const out = texts('好。行。那就这样吧。', replyRules({}, true))
  assert.equal(out.length, 1, '三个短句应该合成一条：' + JSON.stringify(out))
})

test('清单/汇报整段发（多小标题、编号列表、代码块）', () => {
  const report = '【问题在哪】\n缓存没清干净\n【结论】\n不用升配\n【建议】\n1. 长会话勤开新的\n2. 换按量计费\n3. 少读大文件'
  const out = texts(report, replyRules({}, true))
  assert.equal(out.length, 1, '汇报不该被拆散：' + JSON.stringify(out))
  assert.ok(out[0].includes('【结论】') && out[0].includes('3. 少读大文件'), '内容要完整')
  const code = '看这段：\n```\nnpm run build\n```\n跑完就好'
  assert.equal(texts(code, replyRules({}, true)).length, 1, '代码块整段发')
})

test('关掉「清单整段发」后，同样的汇报会按上限拆', () => {
  const report = '【问题在哪】\n缓存没清干净\n【结论】\n不用升配\n【建议】\n1. 长会话勤开新的\n2. 换按量计费\n3. 少读大文件'
  const out = texts(report, { maxChars: 20, keepReports: false })
  assert.ok(out.length >= 2, '关掉后应该拆：' + JSON.stringify(out))
})

test('时间里的冒号永远不是切点（两种情况都守住）', () => {
  const raw = '查了 你猜对了一半 【M Plan 现在状态】 5小时窗口 今天09:22开的 到14:22 已经烧掉55% 剩45% 周窗口到下周三09:22 只烧了6% 剩94%'
  for (const rules of [replyRules({}, true), { maxChars: 30 }]) {
    const joined = texts(raw, rules).join('')
    assert.ok(joined.includes('到14:22'), '时间不能断开：' + JSON.stringify(texts(raw, rules)))
    assert.ok(joined.includes('09:22'), '时间不能断开')
  }
})

test('带路径的技术说明按段落发，不挤成一条巨块（2026-11-05 实测）', () => {
  const NL = String.fromCharCode(10)
  const t = [
    '提示词整理好了 文档和补丁脚本都发你了',
    '',
    '先说要改哪儿',
    '/home/user/harness/.dsh/profile-plugins/dsh-qq-hub/src/features/memory.js 第 1091 到 1093 行 那是自带的模板',
    '',
    '这段插件是硬编码的 面板里没有输入框 人设卡也管不到它 它在插件内部另开一次模型调用 自己带 system',
    '',
    '要贴的核心就是这段 贴到 1091 那行反引号里 里面三个占位符原样留着',
  ].join(NL)
  const r = parseReply(t, replyRules({ reply: { privateMaxChars: 120 } }, false))
  assert.ok(r.items.length >= 3, '段落各是一条，实际 ' + r.items.length)
  for (const it of r.items) assert.ok(it.value.length <= 240, '每条都不许变成巨块：' + it.value.length)
  assert.ok(r.items.some((it) => it.value.includes('/home/user/harness/.dsh/profile-plugins/dsh-qq-hub/src/features/memory.js')), '路径必须完整留在同一条里')
})

test('真报表（两个以上小标题）仍然整段发', () => {
  const NL = String.fromCharCode(10)
  const t = ['刚拉的数', '', '【5小时窗口】09:22 到 14:22', '剩 33% 已烧 67%', '', '【周窗口】09:22 到下周三', '剩 93% 已烧 7%'].join(NL)
  assert.equal(parseReply(t, replyRules({}, false)).items.length, 1)
})

test('两三行各一句完整的话（16~30 字）是聊天分行，不是排版（2026-11-06 事故）', () => {
  // 事故：两行各 17/12 字，旧行长阈值 15 把它判成长文排版，soft 边界再按 0.45 概率合，
  // 一半概率粘成一条带 \n 的消息发出。新口径：行数 ≤3 且每行 ≤30 字 = hard。
  const raw = '今晚刚见证教程没捂热号先凉，你说呢\n不如先吃饭，别赶着送人头'
  const out = texts(raw, replyRules({}, true))
  assert.deepEqual(out, ['今晚刚见证教程没捂热号先凉，你说呢', '不如先吃饭，别赶着送人头'])
  // 同族：三行都在 16~30 字区间
  const raw3 = '今天那个副本打得我头疼\n野队队友一个比一个离谱\n下周还是自己单刷吧'
  assert.deepEqual(texts(raw3, replyRules({}, true)), raw3.split('\n'))
})

// ---- bubbleLimit：硬顶（面板）/ 显式 ||| / 软顶（四态收尾）三层口径 ----
// 2026-11-24：礼让把 maxBubbles 压到 1，她写的三条被换行粘成一条（真机 08:16）。
// 现在的分层：maxBubbles 是硬顶，谁都越不过；softMaxBubbles 只压自动切出来的气泡；
// 她自己写的 ||| 至少放行那几条。
test('bubbleLimit：硬顶 ≥ 显式 ||| ≥ 软顶，非法值都有兜底', () => {
  assert.equal(bubbleLimit({ maxBubbles: 6 }, 1), 6, '没有软顶时按硬顶')
  assert.equal(bubbleLimit({ maxBubbles: 6, softMaxBubbles: 1 }, 3), 3, '显式边界压过软顶')
  assert.equal(bubbleLimit({ maxBubbles: 6, softMaxBubbles: 1 }, 1), 1, '没有显式边界时软顶生效')
  assert.equal(bubbleLimit({ maxBubbles: 6, softMaxBubbles: 4 }, 2), 4, '软顶比显式大就按软顶')
  assert.equal(bubbleLimit({ maxBubbles: 2, softMaxBubbles: 1 }, 4), 2, '谁都不能越过面板硬顶')
  assert.equal(bubbleLimit({ maxBubbles: Number.NaN, softMaxBubbles: -3 }, 2), 6, '非法值退回默认 6')
  assert.equal(bubbleLimit({}, 0), 6, '显式条数给 0 也至少按 1 条算，不会切出 0 条')
})

test('编号条目段不把小标题单独劈成一条气泡，且保留子项换行（2026-11-26 实测）', () => {
  const raw = [
    '查到的核心数如下：',
    '',
    '1. **G7615A（主控 ZX279132）**',
    '   - **NPU 核心数**：**8核（64线程）**。',
    '   - 资料比较透明，各路拆机都一致，没有争议。',
    '',
    '2. **G7615V2 / F7615（主控 ZX279133）**',
    '   - 官方宣传页写着 8核 64线程 NPU，拆机评测也按 8核 64线程算。',
    '   - 论坛老哥认为光猫版阉割成 1核 NPU，并非满血 8核。',
  ].join('\n')
  const out = texts(raw, replyRules({}, false))
  assert.equal(out.length, 3, '开场白 + 第1点 + 第2点共 3 条：' + JSON.stringify(out))
  assert.match(out[1], /^1\. G7615A（主控 ZX279132）\nNPU 核心数：8核（64线程）。\n资料比较透明/, '第 1 点小标题与正文保留在同一条内')
  assert.match(out[2], /8核 64线程算。\n论坛老哥认为光猫版/, '第 2 点子项句号后的换行不被吃掉')
})

test('长文段落里句末标点紧跟换行时，合并保留换行不再把两行粘死', () => {
  const raw = [
    '官方说法：中兴在自家同芯片路由器宣传页明确写着 8核 64线程，拆机评测也按这个算。',
    '论坛说法：部分老哥认为光猫版做了阉割，实际只有 1核。',
  ].join('\n')
  const out = texts(raw, { maxChars: 120, keepReports: false, rand: () => 0.99 })
  assert.equal(out.length, 1)
  assert.match(out[0], /也按这个算。\n论坛说法：/, '句号后的换行必须保留')
})

test('小数开头（2.5G / 1.5W）不被误判成数字列表项强插空行把标题劈孤立', () => {
  const raw = [
    '### 1. 有线 & NPU 转发实测（4 台一致）',
    '* **2.5G 线速能力**：两颗芯片在 64 字节小包下都能双向跑满 2.5G。',
    '* **结论**：四台实测网速没区别。',
    '',
    '### 2. 功耗与发热',
    '',
    'G7615A 功耗最高，关闭 Wi-Fi 约降 1.5W。',
  ].join('\n')
  const out = texts(raw, replyRules({}, false))
  assert.equal(out.length, 2, '应为 2 条完整编号气泡：' + JSON.stringify(out))
  assert.match(out[0], /^1\. 有线 & NPU 转发实测（4 台一致）\n2\.5G 线速能力：/, '2.5G 不应触发空行拆出孤立标题')
  assert.match(out[1], /^2\. 功耗与发热\nG7615A 功耗最高/, '模型自己在编号标题后多打空行时也应与正文合并')
})

test('长 Markdown 文档（含表格与分割线）：表格转规格卡、按章节干净分大段，绝不缝合下章标题', () => {
  const raw = [
    '好了，把你手头的 **烽火 HG5585F** 和 **星网锐捷 SG350H** 一次理清。',
    '',
    '---',
    '',
    '### 一、参数总表',
    '',
    '| 型号 | 主控 | 架构 |',
    '| :--- | :--- | :--- |',
    '| **中兴 G7615A** | ZX279132 | 4 核 A53 |',
    '| **烽火 HG5585F** | 达发 AN7581 | 4 核 ARMv8 |',
    '',
    '---',
    '',
    '### 二、实测结论',
    '',
    '#### 1. 有线实测',
    '- 两颗芯片在 **64 字节小包** 环境下都能跑满 2.5G。',
    '',
    '---',
    '',
    '### 三、选购建议',
    '',
    '直接用 **SG350H** 改桥接就行。',
  ].join('\n')
  const out = texts(raw, replyRules({}, false))
  assert.equal(out.length, 4, '开场白 + 一 + 二 + 三 = 4 条干净气泡：' + JSON.stringify(out))
  assert.doesNotMatch(out[0], /━━|一、/, '开场白不粘分割线和下章标题')
  assert.match(out[0], /手头的烽火 HG5585F/, '中文加粗旁多余空格清理，且中英文间保留空格')
  assert.match(out[1], /^一、参数总表[\s\S]*▪ 中兴 G7615A\n主控：ZX279132｜架构：4 核 A53/, 'Markdown 表格转成手机规格卡')
  assert.doesNotMatch(out[1], /:---/, '不再把 | :--- | 乱码发到 QQ')
  assert.match(out[2], /^二、实测结论[\s\S]*在 64 字节小包环境下/, '二章标题与正文在同一条，且 64 字节前保留自然空格')
  assert.match(out[3], /^三、选购建议[\s\S]*直接用 SG350H 改桥接就行/, '三章标题与正文在同一条')
})
