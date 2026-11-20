// 真机端到端：用真的 Xvfb + 真的浏览器跑一遍共享层（不是 stub）。
// 跑法：node test/manual/browser-e2e.mjs <root> <chromePath>

import { createBrowserService } from '../../src/browser/index.js'

const root = process.argv[2] || '/tmp/browser-e2e'
const chromePath = process.argv[3]

const log = {
  info: (...a) => console.log('  [info]', ...a),
  warn: (...a) => console.log('  [warn]', ...a),
  debug: () => {},
}
const cfg = { browser: { chromePath, headless: false, maxConcurrent: 2, idleMinutes: 0, minFreeMB: 0 } }
const svc = createBrowserService({
  root,
  log,
  getConfig: () => cfg,
  policies: { bilibili: ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'biliapi.net'] },
})

const say = (m) => console.log('\n=== ' + m + ' ===')
let failed = 0
const check = (ok, label, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? ' — ' + extra : ''))
  if (!ok) failed++
}

try {
  say('1. probe（不该启动任何东西）')
  const before = await svc.probe()
  check(before.ok, 'probe 通过', before.issues.join('; ') || `chrome=${before.chrome}`)
  check(svc.status().state === 'idle', 'probe 后仍然是 idle')

  say('2. acquire → 真的起 Xvfb + 浏览器')
  const lease = await svc.acquire('bilibili')
  const st = svc.status()
  check(st.state === 'ready', '服务 ready')
  check(st.displayOwned === true, '用的是自管虚拟屏', st.display)
  check(Boolean(st.browser), '浏览器报上了版本', st.browser)
  check(st.active.includes('bilibili'), '租约登记了模块 id')

  say('3. 白名单生效')
  let blocked = false
  try { await lease.goto('https://evil.example/', { waitMs: 1 }) } catch (e) { blocked = e.code === 'BLOCKED' }
  check(blocked, '不在白名单的站点被拒')

  say('4. 打开真页面并读内容')
  await lease.goto('https://www.bilibili.com/', { waitMs: 12000 })
  const page = await lease.content()
  check(page.title.length > 0, '读到了标题', page.title.slice(0, 40))
  check(page.html.length > 1000, '读到了 HTML', `${page.html.length} 字`)

  say('5. 在页面里跑 JS')
  const href = await lease.evaluate('location.href')
  check(/bilibili\.com/.test(href), 'evaluate 返回当前地址', href)

  say('6. 视频真的能播（编解码 + 窗口位置）')
  await lease.goto('https://www.bilibili.com/video/BV1GJ411x7h7', { waitMs: 15000 })
  // 等缓冲：readyState >= 2 才算真有数据。软解 + 首次加载慢一点，最多等 20 秒。
  let v = { rs: 0 }
  for (let i = 0; i < 20; i++) {
    v = await lease.evaluate(`(() => {
      const x = document.querySelector('video')
      if (!x) return { none: true, rs: 0 }
      return { w: x.videoWidth, h: x.videoHeight, t: x.currentTime, rs: x.readyState, err: x.error?.code || 0, paused: x.paused }
    })()`)
    if (v.rs >= 2 && v.w > 0) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check(!v.none, '页面上找到了 video 元素')
  check(v.w > 0, '有画宽（不是黑屏）', `${v.w}x${v.h}`)
  check(v.rs >= 2, 'readyState 够（真的缓冲到数据）', String(v.rs))
  check(v.err === 0, '没有解码错误', String(v.err))

  // 决定性判据：时间轴真的在走（能播 vs 只是读到了元数据）
  const t0 = Number(v.t) || 0
  await new Promise((r) => setTimeout(r, 2500))
  const t1 = Number(await lease.evaluate(`document.querySelector('video')?.currentTime || 0`))
  check(t1 > t0, '播放时间轴在推进（真的在播）', `${t0.toFixed(2)} → ${t1.toFixed(2)}`)

  say('7. 截图')
  const shot = await lease.screenshot()
  check(shot.startsWith('data:image/png;base64,'), '截图返回 PNG', `${Math.round(shot.length / 1024)} KB`)

  say('8. 虚拟屏下 show() 要老实')
  const shown = await lease.show(true)
  check(shown.ok === false && /虚拟屏|看不见/.test(shown.message), 'show 说明看不见', shown.message)

  say('9. release 不停浏览器')
  lease.release()
  check(svc.status().state === 'ready', 'release 后浏览器还在（别的模块要用）')

  say('10. 第二个模块复用同一个浏览器')
  const l2 = await svc.acquire('tieba-reader')
  check(svc.status().port === st.port, '还是同一个浏览器进程', `端口 ${st.port}`)
  check(svc.status().tabs >= 2, '两个模块各有标签页', String(svc.status().tabs))
  l2.release()

  say('11. dispose 全关，不留孤儿')
  const pid = svc.status().port
  await svc.dispose()
  check(svc.status().state === 'idle', '服务回到 idle')
  const { execSync } = await import('node:child_process')
  const left = execSync(
    `ps -eo args | grep -F "remote-debugging-port" | grep -F "${root}" | grep -v grep | wc -l`,
  ).toString().trim()
  check(left === '0', '没有浏览器进程残留', `port=${pid}`)
  const xvfbLeft = execSync(`ps -eo args | grep -F "Xvfb" | grep -e "-displayfd" | grep -v grep | wc -l`).toString().trim()
  check(xvfbLeft === '0', '没有 Xvfb 残留')
} catch (error) {
  console.error('\n💥 未捕获错误：', error.message)
  if (error.stderr) console.error(error.stderr.slice(-800))
  failed++
  try { await svc.dispose() } catch {}
} finally {
  console.log(failed === 0 ? '\n🎉 全部通过' : `\n❌ 失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}