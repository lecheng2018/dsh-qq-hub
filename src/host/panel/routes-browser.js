// QQ Hub · 面板路由：共享浏览器（状态 / 安装 / 开关）
//
// 安装是**用户态**的：把 deb 下到插件数据目录解包，不需要管理员权限。
// 装的过程要几十秒到几分钟（下 Chrome 有一百多兆），所以这里做「后台跑 + 轮询进度」，
// 不要让面板请求一直挂着。

import { join } from 'node:path'
import { dataDir } from '../../core/store.js'
import { installBrowser, verifyInstalled, installedInfo } from '../../browser/install.js'

const rootOf = () => dataDir('browser')

export function registerBrowserRoutes({ route, readBody, browser, getConfig, logger, openFolder }) {
  const log = logger?.child?.('浏览器安装') || console

  // 安装状态：idle | running | failed | done
  let job = { state: 'idle', message: '', startedAt: 0, result: null }

  // 审计 Q18：/browser/status 的 installedInfo（递归 statSync 计目录大小）与
  // verifyInstalled（对浏览器二进制跑一次 ldd）都是重探测，过去每次轮询都全量跑。
  // 加 10s TTL 缓存；安装任务结束（done/failed）时立即失效——装完面板要看到新状态。
  let probeCache = { at: 0, root: '', info: null, verdict: null }
  const PROBE_TTL_MS = 10_000
  function invalidateProbe() { probeCache = { at: 0, root: '', info: null, verdict: null } }

  route('/browser/status', async () => {
    const root = rootOf()
    let info, verdict
    const cacheFresh = probeCache.root === root && Date.now() - probeCache.at < PROBE_TTL_MS
    if (cacheFresh) {
      ;({ info, verdict } = probeCache)
    } else {
      info = installedInfo(root)
      verdict = verifyInstalled(root)
      probeCache = { at: Date.now(), root, info, verdict }
    }
    const live = browser ? browser.status() : null
    return {
      ok: true,
      enabled: getConfig().browser?.enabled !== false,
      installed: verdict.ok,
      missing: verdict.reason && !verdict.ok ? verdict.reason : '',
      info: info ? { browser: info.browser, kind: info.kind, sizeMB: Math.round((info.sizeBytes || 0) / 1048576), installedAt: info.installedAt } : null,
      root,
      live,
      job,
    }
  })

  route('/browser/probe', async () => {
    if (!browser) return { ok: false, issues: ['共享浏览器没启用（配置里 browser.enabled 关着）'] }
    return browser.probe()
  })

  route('/browser/install', async () => {
    if (job.state === 'running') return { ok: false, message: '正在装，别急' }
    job = { state: 'running', message: '开始', startedAt: Date.now(), result: null }
    const root = rootOf()
    const kind = getConfig().browser?.chrome === false ? 'chromium' : 'auto'
    // 不 await：让面板能立刻拿到「已开始」，之后轮询 /browser/status
    installBrowser({ root, browser: kind, log })
      .then((r) => {
        invalidateProbe() // 审计 Q18：装完立刻失效探测缓存，面板下一次轮询看到新状态
        job = { state: r.ok ? 'done' : 'failed', message: r.ok ? '装好了' : (r.message || '失败'), startedAt: job.startedAt, result: r }
        if (r.ok) log?.info?.(`装好了：${r.browser}`)
      })
      .catch((error) => {
        job = { state: 'failed', message: String(error?.message || error), startedAt: job.startedAt, result: null }
      })
    return { ok: true, message: '开始安装（下包可能要几分钟），装完这张卡片会自己刷新' }
  })

  route('/browser/open-folder', async () => {
    const dir = rootOf()
    try { openFolder(dir) } catch (error) { return { ok: false, message: error.message } }
    return { ok: true, message: dir }
  })

  /** 立刻关掉浏览器（排障用：卡住时不想等空闲超时）。 */
  route('/browser/shutdown', async () => {
    if (!browser) return { ok: false, message: '共享浏览器没启用' }
    await browser.shutdown('面板手动关闭')
    return { ok: true, message: '已关闭' }
  })

  /** 开/关 VNC：无桌面时主人要靠它看见浏览器窗口。 */
  route('/browser/vnc', async (req) => {
    if (!browser) return { ok: false, message: '共享浏览器没启用' }
    const b = await readBody(req)
    return browser.vnc(String(b.action || 'status'))
  })
}

export { rootOf as browserRoot }