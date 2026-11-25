// 表情图包：一个不依赖第三方库的极简 ZIP 读写器。
//
// 导出用 stored（不压缩）：表情图本身已经是压缩格式，再 deflate 收益很小，
// 换来的是实现简单、可审计。导入同时支持 stored / deflate（别人用普通 ZIP 工具
// 打包也能读）。所有上限都在这里兜底：单张 8 MiB、整包 64 MiB、最多 600 张，
// 拒绝绝对路径 / `..` / 反斜杠，避免解包时写穿目录。

import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

export const PACK_FORMAT = 'dsh-qq-hub-sticker-pack'
export const PACK_VERSION = 1
export const PACK_MAX_BYTES = 64 * 1024 * 1024
export const PACK_MAX_ENTRY_BYTES = 8 * 1024 * 1024
export const PACK_MAX_ENTRIES = 600

const MANIFEST = 'manifest.json'
const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const UTF8_FLAG = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function safeEntryName(name) {
  const raw = String(name || '')
  if (!raw || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return false
  const parts = raw.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return false
  if (raw === MANIFEST) return true
  return raw.startsWith('stickers/') && IMAGE_EXT.test(raw) && parts.length === 2
}

function writeEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(LOCAL_SIG, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(UTF8_FLAG, 6)
  local.writeUInt16LE(METHOD_STORE, 8)
  local.writeUInt16LE(0, 10) // time
  local.writeUInt16LE(0x21, 12) // 1980-01-01
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  return { local: Buffer.concat([local, nameBuf, data]), nameBuf, crc, size: data.length, offset: 0 }
}

/**
 * @param {Array<{name:string,data:Buffer,item?:object}>} entries
 * @returns {Buffer}
 */
export function buildStickerPack(entries) {
  const files = []
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || '')
    if (!safeEntryName(name) || name === MANIFEST) throw new Error('图包里有非法文件名：' + name)
    if (seen.has(name)) continue
    if (!Buffer.isBuffer(entry.data) || !entry.data.length) continue
    if (entry.data.length > PACK_MAX_ENTRY_BYTES) throw new Error(`单张表情超过 ${Math.round(PACK_MAX_ENTRY_BYTES / 1024 / 1024)}MB：${name}`)
    seen.add(name)
    files.push({ name, data: entry.data, item: entry.item || {} })
    if (files.length > PACK_MAX_ENTRIES) throw new Error(`图包最多 ${PACK_MAX_ENTRIES} 张`)
  }
  if (!files.length) throw new Error('没有可导出的表情')
  const manifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    items: files.map(({ name, data, item }) => ({
      file: name,
      md5: String(item.md5 || createHash('md5').update(data).digest('hex')),
      name: String(item.name || '').slice(0, 12),
      tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 5) : [],
      from: String(item.from || ''),
      at: Number(item.at) || 0,
    })),
  }
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  if (manifestData.length > PACK_MAX_ENTRY_BYTES) throw new Error('图包清单太大了')
  const all = [{ name: MANIFEST, data: manifestData }, ...files.map(({ name, data }) => ({ name, data }))]
  const total = all.reduce((n, e) => n + e.data.length, 0)
  if (total > PACK_MAX_BYTES) throw new Error(`图包超过 ${Math.round(PACK_MAX_BYTES / 1024 / 1024)}MB`)

  const parts = []
  const central = []
  let offset = 0
  for (const entry of all) {
    const written = writeEntry(entry.name, entry.data)
    const local = written.local
    parts.push(local)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CENTRAL_SIG, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(UTF8_FLAG, 8)
    cd.writeUInt16LE(METHOD_STORE, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(written.crc, 16)
    cd.writeUInt32LE(entry.data.length, 20)
    cd.writeUInt32LE(entry.data.length, 24)
    cd.writeUInt16LE(written.nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, written.nameBuf]))
    offset += local.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(all.length, 8)
  eocd.writeUInt16LE(all.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, centralBuf, eocd])
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * @param {Buffer} buf
 * @returns {{items:Array<{name:string,tags:string[],md5:string,data:Buffer}>, exportedAt:string}}
 */
export function readStickerPack(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('图包是空的')
  if (buf.length > PACK_MAX_BYTES) throw new Error(`图包超过 ${Math.round(PACK_MAX_BYTES / 1024 / 1024)}MB`)
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是 ZIP 图包')
  const count = buf.readUInt16LE(eocd + 10)
  if (count < 1 || count > PACK_MAX_ENTRIES) throw new Error(`图包条目数不合法（${count}）`)
  const centralSize = buf.readUInt32LE(eocd + 12)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buf.length) throw new Error('图包目录越界')

  const entries = new Map()
  let total = 0
  let pos = centralOffset
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error('图包目录损坏')
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16)
    const compSize = buf.readUInt32LE(pos + 20)
    const rawSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const nameEnd = pos + 46 + nameLen
    if (nameEnd > buf.length) throw new Error('图包文件名越界')
    const name = buf.subarray(pos + 46, nameEnd).toString('utf8')
    if (!safeEntryName(name)) throw new Error('图包里有非法文件名：' + name)
    if (entries.has(name)) throw new Error('图包里有重复文件：' + name)
    if (flags & 0x1) throw new Error('图包不支持加密条目')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error('图包压缩方式不支持：' + method)
    if (rawSize > PACK_MAX_ENTRY_BYTES || compSize > PACK_MAX_ENTRY_BYTES) throw new Error('图包单张超过大小上限：' + name)
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('图包本地头损坏：' + name)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error('图包数据越界：' + name)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    try {
      data = method === METHOD_DEFLATE ? inflateRawSync(raw, { maxOutputLength: PACK_MAX_ENTRY_BYTES }) : Buffer.from(raw)
    } catch (error) {
      throw new Error('图包解压失败：' + name)
    }
    if (data.length !== rawSize) throw new Error('图包解压后大小不符：' + name)
    if (crc32(data) !== crc) throw new Error('图包校验失败：' + name)
    total += data.length
    if (total > PACK_MAX_BYTES) throw new Error('图包解压后超过大小上限')
    entries.set(name, data)
    pos = nameEnd + extraLen + commentLen
  }

  const manifestData = entries.get(MANIFEST)
  if (!manifestData) throw new Error('图包缺少 manifest.json')
  let manifest
  try { manifest = JSON.parse(manifestData.toString('utf8')) } catch (error) { throw new Error('图包清单不是合法 JSON') }
  if (!manifest || manifest.format !== PACK_FORMAT || Number(manifest.version) !== PACK_VERSION) throw new Error('不是 QQ Hub 表情图包')
  if (!Array.isArray(manifest.items) || manifest.items.length > PACK_MAX_ENTRIES) throw new Error('图包清单条目数不合法')

  const out = []
  for (const item of manifest.items) {
    const file = String(item?.file || '')
    if (!safeEntryName(file) || file === MANIFEST) throw new Error('图包清单引用了非法文件：' + file)
    const data = entries.get(file)
    if (!data) throw new Error('图包缺少文件：' + file)
    const md5 = createHash('md5').update(data).digest('hex')
    if (item.md5 && String(item.md5).toLowerCase() !== md5) throw new Error('图包文件校验失败：' + file)
    out.push({
      data,
      md5,
      name: String(item.name || '').slice(0, 12),
      tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t).slice(0, 8)).slice(0, 5) : [],
    })
  }
  if (!out.length) throw new Error('图包里没有表情')
  return { items: out, exportedAt: String(manifest.exportedAt || '') }
}
