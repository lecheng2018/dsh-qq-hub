// fnOS 祖先目录不可读 → DSH 附件登记抛 EACCES 的回归测试。
//
// 线上真实故障：DSH 的 LocalAttachmentStore 在存图时会一层层向上 open(祖先目录, O_RDONLY)
// 做 fsync 耐久性同步；fnOS 把 /vol2/@appshare 这类祖先设成「可穿越但不可读」，
// 非 root 进程 open 就 EACCES，整条 admitPromptContent() 链路失败，
// 最终在 dsh-llm-pi-ai 里变成 Cannot read properties of undefined (reading 'attachmentId')。
//
// 这里用 /tmp 下「mode 0o111（能穿越、不能读）」的目录精确复现该场景，验证补丁确实生效。
// 补丁是**进程级全局**的（改的是内建 fs.promises），所以两种情况必须各起一个子进程跑，
// 否则先跑的补丁会污染后跑的「不打补丁」基线。
// 本机没装 dsh-attachment-local 时自动跳过——这个测试只在装了 DSH 的机器上跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, '..', 'src', 'core', 'fnos-fsync-patch.js')
const NODE = process.execPath

/** 找 Harness 进程真正加载的 dsh-attachment-local 副本（.pnpm 里的那份）。
 *  只扫 version/node_modules/.pnpm 的一层目录名，不递归整棵依赖树（太慢）。
 *  顶层 node_modules/@deepseek-ai/... 可能是后装的、自带 fnos 容错的新版本，
 *  拿它当「不打补丁」基线会假阳性，所以必须精确指向 .pnpm 副本。
 */
function findAttachmentLib () {
  const servers = ['/vol2/@appdata/Harness/server', '/vol2/@appdata/Harness'].filter(existsSync)
  const hits = []
  for (const server of servers) {
    let versions = []
    try { versions = readdirSync(server) } catch { continue }
    for (const v of versions) {
      const pnpm = join(server, v, 'node_modules', '.pnpm')
      let pkgs = []
      try { pkgs = readdirSync(pnpm) } catch { continue }
      for (const pkg of pkgs) {
        if (!pkg.startsWith('@deepseek-ai+dsh-attachment-local@')) continue
        const lib = join(pnpm, pkg, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js')
        if (existsSync(lib)) hits.push({ version: v, lib })
      }
    }
  }
  if (!hits.length) return null
  hits.sort((a, b) => b.version.localeCompare(a.version))
  return hits[0].lib
}

const ATT_LIB = findAttachmentLib()

/** 造一棵「祖先可穿越不可读、子目录可写」的假目录，返回 { base, root }。 */
function makeFakeTree () {
  const base = mkdtempSync(join(tmpdir(), 'fnos-patch-'))
  const root = join(base, 'anc', 'inner', 'home', 'attachments', 'v1')
  mkdirSync(root, { recursive: true })
  chmodSync(join(base, 'anc'), 0o111) // 能穿越、不能读 —— 与 fnOS trim_acl 祖先一致
  return { base, root }
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 在一个**全新的子进程**里驱动 DSH 的 prepareImageFile + commitPreparedImageFile。
 * @param {string} root 版本化附件根
 * @param {boolean} withPatch 是否先装补丁
 * @returns {{ok:boolean, ref?:object, code?:string, message?:string}}
 */
function saveImageUnder (root, withPatch) {
  const code = `
    ${withPatch ? `const { patchFnosFsync } = await import('file://${PATCH}'); if (patchFnosFsync() !== true) { console.log('__PATCH_FAILED__'); process.exit(0) }` : ''}
    const { prepareImageFile, commitPreparedImageFile } = await import('file://${ATT_LIB}')
    const png = Uint8Array.from(Buffer.from('${PNG_B64}', 'base64'))
    const limits = { maxImageBytes: 52428800, maxPixels: 64e6, maxDimension: 65535, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
    const policy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 }
    try {
      const prepared = await prepareImageFile({ data: png, mediaType: 'image/png', name: 'x.png' }, limits, policy)
      const ref = await commitPreparedImageFile(${JSON.stringify(root)}, prepared)
      console.log('__JSON__' + JSON.stringify({ ok: true, ref }))
    } catch (e) {
      console.log('__JSON__' + JSON.stringify({ ok: false, code: e && e.code, message: String(e && e.message) }))
    }
  `
  const r = spawnSync(NODE, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 180_000 })
  if (r.stdout.includes('__PATCH_FAILED__')) return { ok: false, code: 'PATCH_FAILED', message: '补丁没装上' }
  const line = (r.stdout || '').split('\n').find((x) => x.startsWith('__JSON__'))
  if (!line) return { ok: false, code: 'NO_OUTPUT', message: (r.stderr || r.stdout || '').slice(-300) }
  return JSON.parse(line.slice('__JSON__'.length))
}

test('祖先目录不可读时，补丁让附件登记成功', { skip: ATT_LIB ? false : '本机没有 dsh-attachment-local，跳过' }, async (t) => {
  await t.test('不打补丁：EACCES —— 线上故障复现', () => {
    const { base, root } = makeFakeTree()
    try {
      const got = saveImageUnder(root, false)
      assert.equal(got.ok, false, '没有补丁时应该失败')
      assert.equal(got.code, 'EACCES', '错误码必须是 EACCES，实际：' + JSON.stringify(got))
      assert.match(got.message, /anc/, '应该是卡在不可读的祖先目录上')
    } finally {
      chmodSync(join(base, 'anc'), 0o755)
      rmSync(base, { recursive: true, force: true })
    }
  })

  await t.test('打了补丁：图片正常落盘，拿到正式 attachmentId', () => {
    const { base, root } = makeFakeTree()
    try {
      const got = saveImageUnder(root, true)
      assert.equal(got.ok, true, '打补丁后应该成功，实际：' + JSON.stringify(got))
      assert.match(got.ref.attachmentId, /^sha256:[0-9a-f]{64}$/, '必须是正式附件 id，不是裸块')
      assert.equal(got.ref.mediaType, 'image/png')
    } finally {
      chmodSync(join(base, 'anc'), 0o755)
      rmSync(base, { recursive: true, force: true })
    }
  })
})

test('补丁只兜只读打开目录，不掩盖写入路径与只读普通文件的真实权限错误', {
  // chmod 0o000 → open EACCES 是 POSIX 语义；Windows 上 0o000 只清只读属性，
  // open 照样成功，「Missing expected rejection」是环境差异不是补丁缺陷。
  skip: process.platform === 'win32' ? 'POSIX chmod 权限语义，Windows 无法复现 EACCES（CI/Linux 上照常跑）' : false,
}, async () => {
  const { patchFnosFsync } = await import(`file://${PATCH}`)
  assert.equal(patchFnosFsync(), true, '补丁应该装上')
  const fs = require('node:fs')
  // 写路径失败必须照常抛，绝不能返回 noop handle 掩盖问题
  await assert.rejects(() => fs.promises.open('/vol2/@appshare/__nope__/x', fs.constants.O_WRONLY), '写文件失败不能被吞掉')
  // 只读打开一个「存在但不可读的普通文件」也必须照常抛（不能把假 handle 交给调用方）
  const dir = mkdtempSync(join(tmpdir(), 'fnos-patch-file-'))
  const file = join(dir, 'secret.txt')
  const { writeFileSync } = require('node:fs')
  writeFileSync(file, 'x')
  chmodSync(file, 0o000)
  try {
    await assert.rejects(() => fs.promises.open(file, fs.constants.O_RDONLY), '只读普通文件 EACCES 不能被吞')
  } finally {
    chmodSync(file, 0o644)
    rmSync(dir, { recursive: true, force: true })
  }
})
