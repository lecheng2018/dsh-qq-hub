function apiBaseFrom (href) {
  try {
    const u = new URL(href)
    // about:blank / data: / 自定义 scheme 没有可用的站点根：退回根路径，和以前一样
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/qq-hub/api'
    const p = u.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '')
    return (p || '') + '/qq-hub/api'
  } catch (e) {
    // baseURI 都解析不出来（about:blank 之类）：退回老的根路径，起码和以前一样
    return '/qq-hub/api'
  }
}
const API = apiBaseFrom(typeof document !== 'undefined' && document.baseURI
  ? document.baseURI
  : (typeof location !== 'undefined' ? location.href : ''))

// ---------------- 小工具 ----------------
// 服务器不回 JSON 时（登录过期的 401 文本、门户/网关的 404 HTML、反向代理错误页），
// 浏览器只会报 “The string did not match the expected pattern.”（WebKit）或者
// “Unexpected token '<'”（Chromium），一句能用的信息都没有。这里自己读文本再解析，
// 把状态码和正文开头写进消息里，下次挂载/鉴权出问题一眼就能看出打到了谁身上。

export { apiBaseFrom, API }
