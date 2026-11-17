import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { deflateRawSync, crc32 } from 'node:zlib'

const dir = fileURLToPath(new URL('../', import.meta.url))
const filesToPack = ['index.mjs', 'prompt.mjs', 'verifier.mjs', 'store.mjs', 'history-miner.mjs', 'panel.js', 'package.json', 'README.md']

function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const path = Buffer.from(name, 'utf8')
    const method = 8
    const body = deflateRawSync(data)

    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(method, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)

    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }

  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const count = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralDir, end])
}

const fileMap = {}
for (const f of filesToPack) {
  fileMap[f] = readFileSync(join(dir, f))
}

const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const zipBuf = buildZip(fileMap)
const outZip = resolve(dir, `distill-v${pkg.version}.zip`)
writeFileSync(outZip, zipBuf)

const sha256 = createHash('sha256').update(zipBuf).digest('hex')

console.log(`[distill] 打包完成: ${outZip}`)
console.log(`大小: ${(zipBuf.length / 1024).toFixed(2)} KB`)
console.log(`SHA-256: ${sha256}`)
console.log('\n--- QQ Hub 模块市场 index.json 条目范例 ---')
console.log(JSON.stringify({
  id: 'distill',
  name: '群友蒸馏（MaiBot 风格）',
  version: pkg.version,
  api: 1,
  minPluginVersion: '1.4.0',
  description: pkg.description,
  path: `distill/distill-v${pkg.version}.zip`,
  sha256: sha256,
  capabilities: ['context', 'message', 'panel']
}, null, 2))
