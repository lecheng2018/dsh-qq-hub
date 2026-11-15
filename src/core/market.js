// 模块市场「分发半套」（PLAN-模块市场 M2/M3/M4）：索引多源 failover、下载校验、
// 原子安装、更新检查（不自动更新）、卸载、撤回。语义移植上游 community.js（MIT，注明出处），
// 按 qq-hub 架构重写：outbox 收口 / 记忆 fail-closed 由现有模块 SDK 天然继承（api.dataDir 沙箱）。
//
// 安全红线（PLAN §5）：
//  R1 zip 四重防护：safeName 防 zip-slip + 拒加密 + 只 store/deflate + CRC32；下载先核 sha256
//  R2 id 白名单正则先于路径拼接
//  R3 原子落位：.<id>.installing 暂存 → checkDef 校验 → 改名；失败清暂存
//  R4 默认不自动更新；安装/更新须主人面板操作；replacesBuiltin 要 confirmReplace
//  R10 索引 fail-closed：schema 门禁 + 条目字段校验，缺关键字段拒条目不拒整个索引
//  R11 revoked 命中显示原因；delisted 标记；remove 支持 purge
//
// 装模块 = 装进程内代码：capabilities 只展示，不是安全边界（MODULE_SPEC 原话）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync, crc32 } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { API_VERSION, checkDef, userDir } from './modules.js'
import { dataDir } from './store.js'
import { assertPublicUrl } from './net.js'

export const REGISTRY_URL = 'https://raw.githubusercontent.com/lecheng2018/dsh-qq-hub-mods/registry/index.json'
// 多源 failover（比上游强一档）：raw → jsdelivr CDN；config.modules.market.indexUrls / env 可追加覆盖
export const DEFAULT_INDEX_URLS = [
  REGISTRY_URL,
  'https://cdn.jsdelivr.net/gh/lecheng2018/dsh-qq-hub-mods@registry/index.json',
]
export const SOURCE_FILE = '.qqhub-source.json'
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const INDEX_TTL = 5 * 60_000
const RETRY_MS = 1000

const isNetError = (error) => error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError' || Boolean(error?.cause?.code)
const netError = (error) => new Error(`连不上索引源（${error?.cause?.code || error?.name || error?.message}），检查网络或代理后再试`)

async function withRetry(fn, retryMs) {
  try { return await fn() } catch (error) {
    if (!isNetError(error)) throw error
    await new Promise((done) => setTimeout(done, retryMs))
    try { return await fn() } catch (again) { throw isNetError(again) ? netError(again) : again }
  }
}

async function readBody(r, onBytes) {
  if (!r.body) return Buffer.from(await r.arrayBuffer())
  const chunks = []
  let got = 0
  for await (const chunk of r.body) {
    got += chunk.length
    if (got > MAX_ZIP_BYTES) throw new Error('安装包太大')
    chunks.push(chunk)
    onBytes(got)
  }
  return Buffer.concat(chunks)
}

/** 只比 x.y.z：1.2.0-beta.1 算满足 minPluginVersion 1.2.0。 */
export function compareVersions(a, b) {
  const x = String(a).split('-')[0].split('.').map(Number)
  const y = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  return 0
}

function safeName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}

/** 解开 zip，返回 Map(路径 → Buffer)。四重防护：路径/加密/压缩方式/CRC（R1）。 */
export function readZip(buf) {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('不是有效的 zip')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const files = new Map()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new Error('zip 不能加密')
    if (name.endsWith('/')) continue
    if (!safeName(name)) throw new Error(`zip 里有不安全的路径：${name}`)
    if (method !== 0 && method !== 8) throw new Error(`zip 用了不支持的压缩方式：${name}`)
    total += size
    if (total > MAX_FILE_BYTES) throw new Error('解压后太大')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 文件头损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES }) : Buffer.from(raw)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 校验失败：${name}`)
    files.set(name, data)
  }
  return files
}

/** R10：条目关键字段校验——缺字段拒条目不拒整个索引；未知字段忽略。 */
export function validEntry(e) {
  if (!e || typeof e !== 'object') return false
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return false
  if (typeof e.version !== 'string' || !/^\d+\.\d+\.\d+/.test(e.version)) return false
  if (typeof e.path !== 'string' || !e.path || e.path.includes('..')) return false
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return false
  return true
}

export function createMarket({ mods, getConfig, setConfig, log, version, alive = () => true, fetcher = fetch, retryMs = RETRY_MS, builtinDir, validateUrl = assertPublicUrl }) {
  const dirOf = (id) => join(userDir(), id)
  let cache = null // { at, index, url }
  let busy = null
  let progress = null

  const marketCfg = () => getConfig().modules?.market || {}
  const enabled = () => marketCfg().enabled === true

  /** 索引源序：env 覆盖 > config.indexUrls > 默认双源。 */
  function indexUrls() {
    const env = String(process.env.DSH_QQ_HUB_MARKET_INDEX_URLS || '').trim()
    if (env) return env.split(',').map((s) => s.trim()).filter(Boolean)
    const custom = marketCfg().indexUrls
    if (Array.isArray(custom) && custom.length) return custom.map(String).filter(Boolean)
    return DEFAULT_INDEX_URLS
  }

  const readSource = (id) => {
    try { return JSON.parse(readFileSync(join(dirOf(id), SOURCE_FILE), 'utf8')) } catch (error) { return null }
  }
  const hasFolder = (id) => existsSync(dirOf(id))

  /** 多源 failover：任一源成功即用；全失败抛最后一个错（不影响已装模块，A2）。 */
  async function loadIndex({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < INDEX_TTL) return cache.index
    const urls = indexUrls()
    let lastError = null
    for (const url of urls) {
      try {
        const index = await withRetry(async () => {
          // SSRF 防护（缺陷：索引源可指向内网）：自定义 indexUrls 也须是公网地址。
          await validateUrl(url)
          const r = await fetcher(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store', redirect: 'manual' })
          if (r.status >= 300 && r.status < 400) throw new Error('索引源发生重定向，已拒绝（防 SSRF）')
          if (!r.ok) throw new Error(`读不到模块索引（HTTP ${r.status}）`)
          return r.json()
        }, retryMs)
        if (index?.schema !== 1) throw new Error('模块索引的格式是新版的，先更新插件')
        cache = { at: Date.now(), index, url }
        return index
      } catch (error) {
        lastError = error
        log?.debug?.(`索引源失败，换下一个：${url}（${error.message}）`)
      }
    }
    throw lastError || new Error('没有可用的索引源')
  }

  const revokedReason = (index, id, v) => (index.revoked || []).find((r) => r && r.id === id && Array.isArray(r.versions) && r.versions.includes(v))?.reason || ''

  function blocked(index, e) {
    if (Number(e.api) > API_VERSION) return `要扩展接口 v${e.api}，现在的插件只有 v${API_VERSION}，先更新插件`
    if (e.minPluginVersion && compareVersions(e.minPluginVersion, version) > 0) return `要插件 ${e.minPluginVersion} 以上，现在是 ${version}，先更新插件`
    const why = revokedReason(index, e.id, e.version)
    if (why) return `这个版本已撤回：${why}`
    const known = new Set(mods.status().map((m) => m.id))
    const missing = (Array.isArray(e.requires) ? e.requires : []).filter((dep) => !known.has(dep))
    return missing.length ? `要先装：${missing.join('、')}` : ''
  }

  function view(index, e) {
    const src = readSource(e.id)
    return {
      ...e,
      installed: src?.version || '',
      foreign: !src && hasFolder(e.id),
      update: Boolean(src && compareVersions(e.version, src.version) > 0),
      blocked: blocked(index, e),
    }
  }

  async function list({ force = false } = {}) {
    if (!enabled()) return { ok: true, disabled: true, list: [], revoked: [], generatedAt: '' }
    const index = await loadIndex({ force })
    const entries = (index.modules || []).filter(validEntry).map((e) => view(index, e))
    const known = new Set(entries.map((e) => e.id))
    const delisted = mods.status().filter((m) => !known.has(m.id) && readSource(m.id)).map((m) => ({ id: m.id, name: m.name, description: m.description, version: readSource(m.id).version, installed: readSource(m.id).version, delisted: true, capabilities: [], blocked: '' }))
    const revoked = entries.concat(delisted).filter((e) => e.installed && revokedReason(index, e.id, e.installed)).map((e) => ({ id: e.id, version: e.installed, reason: revokedReason(index, e.id, e.installed) }))
    return { ok: true, list: [...entries, ...delisted], revoked, generatedAt: index.generatedAt || '', source: cache?.url || '' }
  }

  async function download(index, e) {
    const url = String(index.assetsBase || '') + e.path
    if (!/^https:\/\//.test(url)) throw new Error('下载地址不对')
    const buf = await withRetry(async () => {
      progress = { id: e.id, name: e.name, stage: 'download', received: 0, total: 0 }
      // SSRF 防护（缺陷：下载 redirect:'follow' 可被重定向到内网/http）：手动重定向，
      // 每一跳都过 validateUrl（拒环回/内网/保留地址），且只允许 https，最多 5 跳。
      let current = url
      let r
      for (let hop = 0; hop < 5; hop++) {
        await validateUrl(current)
        r = await fetcher(current, { signal: AbortSignal.timeout(120_000), redirect: 'manual' })
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers?.get?.('location')
          if (!loc) throw new Error('下载重定向缺少 Location')
          current = new URL(loc, current).href
          if (!/^https:\/\//.test(current)) throw new Error('下载重定向到了非 https 地址，已拒绝')
          continue
        }
        break
      }
      if (r.status >= 300 && r.status < 400) throw new Error('下载重定向次数过多')
      if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
      progress.total = Number(r.headers?.get?.('content-length')) || 0
      return readBody(r, (received) => { progress.received = received })
    }, retryMs)
    if (buf.length > MAX_ZIP_BYTES) throw new Error('安装包太大')
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== e.sha256) throw new Error('安装包校验不通过，已丢弃')
    return buf
  }

  /** R3：暂存 → checkDef → 原子改名。任一步失败清暂存，不留半截模块。 */
  async function place(e, files) {
    const manifest = JSON.parse(files.get('module.json')?.toString('utf8') || 'null')
    if (manifest?.id !== e.id || manifest?.version !== e.version) throw new Error('安装包内容和索引对不上')
    const stage = join(userDir(), `.${e.id}.installing`)
    const old = join(userDir(), `.${e.id}.old`)
    rmSync(stage, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    try {
      const root = resolve(stage) + sep
      for (const [name, data] of files) {
        const dest = resolve(stage, name)
        if (!dest.startsWith(root)) throw new Error(`zip 里有不安全的路径：${name}`)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, data)
      }
      const entry = existsSync(join(stage, 'index.mjs')) ? join(stage, 'index.mjs') : join(stage, 'index.js')
      if (!existsSync(entry)) throw new Error('安装包里没有入口文件')
      // checkDef 前置（R3）：import 暂存入口只跑顶层代码，setup 不执行；校验不过不落位
      const def = (await import(pathToFileURL(entry).href + `?install=${Date.now()}`)).default
      const why = checkDef(def, e.id)
      if (why) throw new Error(`模块校验不过：${why}`)
      writeFileSync(join(stage, SOURCE_FILE), JSON.stringify({ id: e.id, version: e.version, sha256: e.sha256, installedAt: new Date().toISOString() }, null, 2))
      const target = dirOf(e.id)
      if (existsSync(target)) renameSync(target, old)
      try { renameSync(stage, target) } catch (error) {
        if (existsSync(old)) renameSync(old, target)
        throw error
      }
      // 不在这里删 old（缺陷：更新失败丢旧版）：保留 .old 直到 install 确认加载成功，
      // 加载失败时才能回滚到旧版本，而不是新旧两空。
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }

  /** 安装记账写 config（C2：不写别处）；SOURCE_FILE 是 foreign 判定的真相源。 */
  function bookInstall(id, e) {
    const cfg = getConfig()
    const market = { ...(cfg.modules?.market || {}) }
    market.installed = { ...(market.installed || {}), [id]: { version: e.version, sha256: e.sha256, installedAt: new Date().toISOString() } }
    setConfig({ ...cfg, modules: { ...(cfg.modules || {}), market } })
  }
  function bookRemove(id) {
    const cfg = getConfig()
    const market = { ...(cfg.modules?.market || {}) }
    const installed = { ...(market.installed || {}) }
    delete installed[id]
    market.installed = installed
    setConfig({ ...cfg, modules: { ...(cfg.modules || {}), market } })
  }

  const exclusive = (fn) => {
    if (busy) return Promise.resolve({ ok: false, message: '上一个操作还没做完，稍等' })
    busy = Promise.resolve().then(fn).catch((error) => {
      log.warn('模块市场操作失败：', error?.message || error)
      return { ok: false, message: String(error?.message || error) }
    }).finally(() => { busy = null; progress = null })
    return busy
  }

  /** 安装或更新（R4：不自动更新，须面板操作）。同名非市场文件夹不碰；替换内置要 confirmReplace。 */
  const install = (id, { confirmReplace = false } = {}) => exclusive(async () => {
    if (!enabled()) return { ok: false, message: '模块市场没启用，先在面板「扩展 → 市场」里打开' }
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    progress = { id, name: id, stage: 'index', received: 0, total: 0 }
    const index = await loadIndex({ force: true })
    const e = (index.modules || []).find((x) => x && x.id === id)
    if (!e || !validEntry(e)) return { ok: false, message: `市场里没有「${id}」` }
    if (hasFolder(id) && !readSource(id)) return { ok: false, message: `modules/${id} 是你自己的文件夹，不会覆盖；先挪走它` }
    // 替换内置按真实文件判断：索引里的 replacesBuiltin 可能被篡改/漏填，不能只信它
    const replacesBuiltin = Boolean(e.replacesBuiltin) || (builtinDir && existsSync(join(builtinDir, id)))
    if (replacesBuiltin && !confirmReplace) return { ok: false, needConfirm: true, message: `「${e.name}」会替换内置模块，请确认` }
    const why = blocked(index, e)
    if (why) return { ok: false, message: why }
    const files = readZip(await download(index, e))
    progress = { id, name: e.name, stage: 'install', received: 0, total: 0 }
    await place(e, files)
    progress = { id, name: e.name, stage: 'start', received: 0, total: 0 }
    await mods.sync()
    const m = mods.status().find((x) => x.id === id)
    const old = join(userDir(), `.${id}.old`)
    if (m?.error) {
      // 加载失败：回滚到旧版本（place 保留了 .old），不留坏模块也不丢旧版。
      rmSync(dirOf(id), { recursive: true, force: true })
      if (existsSync(old)) renameSync(old, dirOf(id))
      await mods.sync()
      return { ok: false, message: `装上了但加载失败，已回滚到旧版本：${m.error}` }
    }
    // 确认加载成功才删旧版并记账（避免账实不符）
    rmSync(old, { recursive: true, force: true })
    bookInstall(id, e)
    return { ok: true, message: `「${e.name}」${readSource(id) ? '装好了' : '更新好了'}` }
  })

  /** 卸载：只动市场装的（SOURCE_FILE 为凭）；purge 连数据目录和配置一起清。 */
  const remove = (id, { purge = false } = {}) => exclusive(async () => {
    if (!enabled()) return { ok: false, message: '模块市场没启用' }
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    if (!readSource(id)) return { ok: false, message: hasFolder(id) ? `modules/${id} 不是市场装的，不动它` : `没装过「${id}」` }
    rmSync(dirOf(id), { recursive: true, force: true })
    if (purge) {
      rmSync(dataDir('modules-data', id), { recursive: true, force: true })
      const cfg = getConfig()
      const { [id]: _ext, ...ext } = cfg.ext || {}
      const { [id]: _mod, ...modules } = cfg.modules || {}
      setConfig({ ...cfg, ext, modules })
    }
    bookRemove(id)
    await mods.sync()
    return { ok: true, message: purge ? '卸载好了，数据和设置也清掉了' : '卸载好了，数据和设置还留着' }
  })

  return { progress: () => progress, list, install, remove, source: readSource, enabled, loadIndex }
}
