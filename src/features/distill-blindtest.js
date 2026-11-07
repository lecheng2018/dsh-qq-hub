import { parseDistillProfile, renderProfile } from './distill.js'

// 蒸馏效果盲测（2026-11-07）：蒸馏完成后自动跑一次「裁判猜人」评估，把「学得像不像」变成数字。
//
// 方法（对照心理学/图灵测试范式）：
//   ① 从他最近的原话里抽 N 条真话（排除参与过画像的旧句，防裁判背答案）；
//   ② 让「她」照学到的语感就同样话题各仿写一句（用画像做风格参考）；
//   ③ 真话 + 仿写句混排，让独立裁判逐条猜「哪句是本人原话」；
//   ④ 猜对率 → 模仿分：≈50% 裁判分不出（学得好），越高越不像（学得差）。
//
// 裁判是独立调用、不参与蒸馏管线，评测偏差最小化。结果存画像里（blindTest 字段），
// 面板直接展示。这是效果验证环，不是效果保证——分数低说明特征要重学或目标太难模仿。

/**
 * 拼盲测提示词三件套。
 * @param {{name:string, realLines:string[], profile:object, samples:string[]}} p
 *   realLines：参与测试的他本人原话（每条对应一次仿写）
 * @returns {{ mimic:{system,text}, judge:{system,text} }}
 */
export function buildBlindTestPrompts ({ name = '这个人', realLines = [], profile = {}, samples = [] } = {}) {
  const who = String(name || '这个人').slice(0, 20)
  const style = renderProfile(profile, { mode: 'hint', name: who })
    || '（无画像，凭你对他的印象模仿）'
  const targetList = realLines.map((x, i) => `${i + 1}. ${String(x).slice(0, 120)}`).join('\n')
  const sampleList = (samples || []).slice(0, 5).map((x) => `「${String(x).slice(0, 80)}」`).join(' ')
  return {
    // ② 仿写：她照画像就同样话题写一句（真话内容不抄，只借语气）
    mimic: {
      system: [
        '你在 QQ 群里说话。按给出的「语感参照」改写句子：',
        '每条给定句子，**保留话题和意思**，但完全换成参照人物的说话方式（句长、断句、口头禅、语气都照他来）。',
        '输出 JSON：{"lines":["仿写1","仿写2",...]}，条数和输入一致，一一对应。只输出 JSON。',
      ].join('\n'),
      text: `语感参照：\n${style}\n\n要仿写的句子（保持话题，换说法）：\n${targetList}\n\n只输出 JSON 对象。`,
    },
    // ③ 裁判：真话和仿写混排，逐条判「这是本人写的吗」
    judge: {
      system: [
        `下面是「${who}」在 QQ 群里说过的一组话，其中一部分是他本人的原话，另一部分是别人模仿他说话风格写的仿句。`,
        '逐条判断哪句是本人原话。输出 JSON：{"guesses":[1或0,...]}（1=本人原话，0=仿句，与输入顺序一一对应）。',
        '判断依据：用词习惯、句长节奏、口头禅、标点、语气是否自然贴合本人。只输出 JSON。',
      ].join('\n'),
      text: `${who} 的一组话（判断每条是本人原话还是仿句）：\n${sampleList ? '参考（他更多的真实发言）：' + sampleList + '\n\n' : ''}${targetList}\n\n只输出 JSON 对象。`,
    },
  }
}


/** 裁判回包 → 猜对率。猜测条数对不上按缺省 0 记（从严）。 */
export function scoreBlindTest (realLines, guessesRaw) {
  const obj = typeof guessesRaw === 'string' ? parseDistillProfile(guessesRaw) : guessesRaw
  const guesses = (obj && Array.isArray(obj.guesses)) ? obj.guesses : []
  if (!realLines.length) return { score: null, hits: 0, total: 0 }
  let hits = 0
  for (let i = 0; i < realLines.length; i++) {
    if (Number(guesses[i]) === 1) hits++
  }
  return { score: hits / realLines.length, hits, total: realLines.length }
}
