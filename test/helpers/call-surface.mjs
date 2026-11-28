// 「方法调用面」比对工具：给 test/refactor-parity.test.js 与基线生成脚本共用。
//
// 为什么单独抽出来：基线要在「拆分前的单体」上生成一次，生成脚本与守卫必须用**同一份**
// 抽取逻辑，否则基线口径和断言口径会漂移（那会让守卫悄悄失效）。

/**
 * 去掉注释（保留字符串，丢弃行注释与块注释）。
 *
 * 必须做这一步：第一版守卫直接扫原文，结果 `// dispose() 直接 vec.dispose()` 这种
 * **注释里提到的调用**会把「真调用已被删除」掩过去 —— 突变测试实测：删掉真的
 * `vec.dispose?.()` 后守卫仍然通过，因为注释里还写着它。
 *
 * 用状态机而不是单个正则：正则会误伤 `'https://…'` 里的 `//`。
 * 字符串内容保留（写在字符串里的调用属于真实代码路径），注释一律丢弃。
 */
export function stripComments(source) {
  const s = String(source || '')
  let out = ''
  let i = 0
  let quote = ''
  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += s[i + 1] ?? ''; i += 2; continue }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 抽出 `identifier.method(` 形式的调用面。
 *
 * 四种可选链写法都要认，否则会漏掉最关键的那类调用 —— 当初丢的就是
 * `learning?.reload?.()`（**双端**可选链），只认 `x.m(` 的版本看不见它：
 *   a.b(    a?.b(    a.b?.(    a?.b?.(
 *
 * 另外把「延迟注入取数函数」归一成原名字：拆分子模块时为了不抓启动期快照，
 * 会把 `controller.foo()` 改写成 `getController()?.foo()`。两者原本就是同一个对象，
 * 若不归一，守卫会把每一次延迟注入都误报成「调用丢失」。
 *   getController()?.getTurn(  → controller.getTurn
 */
export function callSurface(source, track = null) {
  const allow = track ? new Set(track) : null
  const out = new Set()
  const code = stripComments(source)
  const push = (recv, method) => {
    // getController → controller（只对 get+大写 开头的取数函数做，别动普通变量名）
    const name = /^get[A-Z]/.test(recv) ? recv[3].toLowerCase() + recv.slice(4) : recv
    if (allow && !allow.has(name)) return
    out.add(`${name}.${method}`)
  }
  // 直接调用：a.b( / a?.b( / a.b?.( / a?.b?.( / getX()?.b(
  for (const m of code.matchAll(/([a-zA-Z_][\w]*)\s*(?:\?\.|\.)\s*([a-zA-Z_][\w]*)\s*(?:\?\.)?\s*\(/g)) {
    push(m[1], m[2])
  }
  // 延迟注入取数函数：getFoo()?.bar( / getFoo().bar(
  for (const m of code.matchAll(/\bget([A-Z][\w]*)\(\)\s*(?:\?\.|\.)\s*([a-zA-Z_][\w]*)\s*(?:\?\.)?\s*\(/g)) {
    push(`get${m[1]}`, m[2])
  }
  return out
}