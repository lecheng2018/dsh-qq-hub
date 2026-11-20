// 共享浏览器层的外部入口。
//
// 宿主这样用（只创建一次，不要每个模块各建一份）：
//   const browser = createBrowserService({ root, log, getConfig, policies })
//   core.browser = browser
//   await browser.dispose()   // 宿主退出时
//
// 模块这样用：
//   const svc = api.browser()
//   const lease = await svc.acquire('douyin')
//   try { await lease.goto(url) } finally { lease.release() }

export { createBrowserService, memAvailableMB } from './service.js'
export { createPolicy, DENY_ALL, isPrivateHost, isLiteralIp, hostMatches } from './policy.js'
export { findChrome } from './process.js'
export { findXvfb, canConnectX } from './display.js'
export { parseCookieString } from './cookies.js'