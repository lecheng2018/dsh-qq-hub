export function buildDistillPrompt(lines) {
  const formattedChat = lines.map((line, idx) =>
    `[id:${idx + 1}] [name:${line.name}]\n${line.text}`
  ).join('\n\n')

  const task = `请从上方这段真实群聊发言中，提取可复用的群友接话节奏、口癖与调侃习惯。

【提取要求】
1. 只看文字本身的句式特征与语气风格，忽略图片、表情包占位符与系统指令。
2. 绝对禁止提炼个人的具体现实生平经历（如“被封号、换显卡、买房、考研”等现实资产或生活事实），只能提炼说话口吻。
3. 总结为如下抽象规则：当 "AAAAA" 时，可以使用 "BBBBB"。
   - situation (AAAAA)：触发情境概括（如：遇到离谱事件/表示讽刺的赞同/逆风被调侃时），不超过 20 字。
   - style (BBBBB)：对应的语言口癖或表达习惯（如：使用“笑嘻了”/反问“真假的”/短句空格断句），不超过 20 字。
   - source_id：该条表达依据哪一条消息（对应上面消息的 [id:数字]，只填数字本身）。

【输出格式】
必须严格输出合法的 JSON 数组，以 [ 开头，以 ] 结尾，不要输出任何额外的开场白、总结或思考解释。
输出示例：
[
  {"situation": "遇到游戏失误或逆风", "style": "调侃使用 菜就多练", "source_id": 2},
  {"situation": "表示赞同且带吐槽", "style": "使用 确实有点东西", "source_id": 5}
]`

  return {
    system: '你是一个严格的群聊语言风格提取分析师，只输出合法的 JSON 数组。',
    text: `【群聊记录切片】\n${formattedChat}\n\n【提炼任务要求】\n${task}`
  }
}
