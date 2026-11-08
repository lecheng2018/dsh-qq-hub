// 把抖音视频真正下载到本地，好让 QQ 那边能当文件发出去。
//
// 以前只发文字摘要 + 链接，主人还得自己点开链接去看。这里补上下载这一步。
// 只用 Node 自带的 fetch / fs，不引第三方依赖。

import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 文件名里不能出现的字符换掉，太长就截断。 */
export function safeName(title, awemeId, ext = '.mp4') {
  // # 和 % 也换掉：本地 Linux 允许，但拼 URL 时 # 会当锚点截断、% 会让解码炸掉
  const base = String(title || '').replace(/[\\/:*?"<>|#%\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  const id = String(awemeId || '').replace(/\D/g, '') || 'video'
  return `${base ? base + '-' : ''}${id}${ext}`
}

/**
 * 下载一个视频。
 * @param {object} v      normalizeAweme 的结果（要带 videoUrls）
 * @param {object} opts   { dir, maxMB, referer }
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function downloadVideo(v, opts = {}) {
  const dir = String(opts.dir || '').trim()
  if (!dir) throw new Error('没给下载目录')
  const maxMB = Math.max(1, Number(opts.maxMB) || 50)
  const maxBytes = maxMB * 1024 * 1024
  const urls = (v?.videoUrls || []).filter(Boolean)
  if (!urls.length) throw new Error(v?.isImages ? '这是图文作品，没有视频' : '没拿到视频地址')

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const name = safeName(v.title, v.awemeId)
  const out = join(dir, name)

  let lastError = null
  for (const url of urls) {
    // 换域名重试：抖音的直链会在 play / download 几个域名之间轮换
    const host = new URL(url).host
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 120000)
      let res
      try {
        res = await fetch(url, {
          signal: ctl.signal,
          headers: {
            // 不带 Referer 大概率 403；抖音自己的域名最稳
            referer: opts.referer || 'https://www.douyin.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            range: 'bytes=0-',
          },
        })
      } finally {
        // fetch 拒绝（连不上/被拒）也要清掉 abort 定时器：否则这 120s 里
        // 事件循环被钉住，测试跑不退、生产进程延迟退出（M0 基线卡住根因）
        clearTimeout(timer)
      }
      if (!res.ok || !res.body) throw new Error(`${host} 返回 ${res.status}`)

      // 先看 Content-Length，超限就别下完再报错
      const len = Number(res.headers.get('content-length') || 0)
      if (len && len > maxBytes) throw new Error(`视频 ${(len / 1024 / 1024).toFixed(1)} MB，超过上限 ${maxMB} MB`)

      const tmp = out + '.part'
      try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
        const size = statSync(tmp).size
        if (size > maxBytes) {
          rmSync(tmp, { force: true })
          throw new Error(`视频 ${(size / 1024 / 1024).toFixed(1)} MB，超过上限 ${maxMB} MB`)
        }
        if (size < 1024) {
          rmSync(tmp, { force: true })
          throw new Error('下下来的文件太小，不像视频')
        }
        // 落盘改名（先删旧的同名文件，Windows 上 rename 不覆盖）
        rmSync(out, { force: true })
        renameSync(tmp, out)
        return { path: out, bytes: size }
      } catch (error) {
        rmSync(out + '.part', { force: true })
        throw error
      }
    } catch (error) {
      lastError = error
      // 超限是确定性错误，换域名也没用
      if (/超过上限/.test(error.message)) throw error
    }
  }
  throw new Error('视频下载失败：' + (lastError?.message || '所有地址都试过了'))
}

/**
 * 删掉一个已下载的媒体文件。发完就没用了——QQ 那边已经收到，本地留着只是占盘。
 * 只删我们自己下到媒体目录里的文件，删不掉也不该影响主流程，所以永远不抛。
 * @returns {boolean} 是否真的删掉了
 */
export function discardDownloaded(file) {
  const f = String(file || '').trim()
  if (!f) return false
  try {
    if (existsSync(f)) {
      rmSync(f, { force: true })
      return true
    }
  } catch {
    /* 删不掉就算了，下次启动扫描会兜底 */
  }
  return false
}

/**
 * 兜底清扫：进程中途崩掉 / 被强杀时，下载好的文件会留在目录里没人删。
 * 启动时扫一遍，把超过 maxAgeMs 的旧文件收掉，顺便压一下总量。
 * @param {string} dir
 * @param {{maxAgeMs?: number, maxBytes?: number, keep?: number}} opts
 * @returns {{removed: number, bytes: number}}
 */
export function sweepMediaDir(dir, opts = {}) {
  const out = { removed: 0, bytes: 0 }
  const root = String(dir || '').trim()
  if (!root) return out
  const maxAgeMs = Number(opts.maxAgeMs) || 6 * 3600_000
  const maxBytes = Number(opts.maxBytes) || 500 * 1024 * 1024
  const keep = Math.max(0, Number(opts.keep) || 0)

  let names = []
  try {
    if (!existsSync(root)) return out
    names = readdirSync(root)
  } catch {
    return out
  }

  const files = []
  for (const n of names) {
    const full = join(root, n)
    try {
      const st = statSync(full)
      if (st.isFile()) files.push({ full, size: st.size, mtime: st.mtimeMs })
    } catch {
      /* 跳过读不到的 */
    }
  }
  // 新的在前，保留最近 keep 个
  files.sort((a, b) => b.mtime - a.mtime)
  const now = Date.now()
  let total = files.reduce((n, f) => n + f.size, 0)

  // 从最旧的开始删（数组倒序），keep 个最新的永远不动
  for (let i = files.length - 1; i >= keep; i--) {
    const f = files[i]
    const tooOld = now - f.mtime > maxAgeMs
    const overQuota = total > maxBytes
    if (!tooOld && !overQuota) break
    try {
      rmSync(f.full, { force: true })
      out.removed++
      out.bytes += f.size
      total -= f.size
    } catch {
      /* 删不掉就留着 */
    }
  }
  return out
}
