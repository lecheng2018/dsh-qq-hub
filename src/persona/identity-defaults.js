// 身份解析的默认值（零 import 的叶子模块）。
//
// 为什么单独放一个文件：personas.js 要在提示词兜底里用这个默认名，identity-context.js
// 也要用；如果默认值住在 identity-context.js，两个模块就互相 import 成环——虽然目前
// 只是「函数里用、模块顶层不碰」才没炸，但只要有人在 personas.js 顶层引用它，
// 换个 import 顺序就会 TDZ 崩。默认值放这里，环就没了。

/** 读不到人设卡时的兜底名字（提示词里统一用「该聊天角色」指代）。 */
export const DEFAULT_CHARACTER_NAME = 'AI伴侣'
