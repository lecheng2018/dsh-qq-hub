// 闪传能力层（flash-transfer.js）与模块（flash-transfer/）的回归网。
//
// 网关返回形状刻意不做假设（不同 SnowLuma 版本字段名会漂），所以抽取函数的
// 「认不出返回空」是核心契约：空 = 如实报告网关没给，绝不猜一个值出来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  flashShareInfo, extractFlashFileList, extractFlashDownloadUrls,
  formatFlashFileList, formatFlashDownloadResult, humanSize,
  resolveFlashFileset, downloadFlashFileset,
} from '../src/chat/flash-transfer.js'

// ---------------------------------------------------------------------------
// flashShareInfo：从千奇百怪的段数据里认分享码/文件集 id
// ---------------------------------------------------------------------------

test('认得出标准字段（snake / camel 两种命名）', () => {
  assert.deepEqual(flashShareInfo({ share_code: 'abcd1234' }), { shareCode: 'abcd1234' })
  assert.deepEqual(flashShareInfo({ fileset_id: 'fs-9981-xy' }), { filesetId: 'fs-9981-xy' })
  assert.deepEqual(flashShareInfo({ shareCode: 'abcd1234', title: '设计稿.zip' }), { shareCode: 'abcd1234', title: '设计稿.zip' })
})

test('从 URL 查询参数里认分享码 / 文件集 id', () => {
  assert.deepEqual(
    flashShareInfo({ url: 'https://fi.qq.com/s?share_code=abcd1234' }),
    { shareCode: 'abcd1234' },
  )
  assert.deepEqual(
    flashShareInfo({ jump_url: 'https://x.com/d?filesetId=fs-9981' }),
    { filesetId: 'fs-9981' },
  )
})

test('垃圾输入与认不出的形状一律返回空对象（绝不猜）', () => {
  for (const bad of [undefined, null, '文本', 42, {}, { share_code: '' }, { share_code: 'ab' }, { url: '不是网址' }]) {
    const info = flashShareInfo(bad)
    assert.ok(!('shareCode' in info), `${JSON.stringify(bad)} 不该认出分享码`)
    assert.ok(!('filesetId' in info), `${JSON.stringify(bad)} 不该认出文件集 id`)
  }
})

test('标题保留但截断到 120 字', () => {
  assert.equal(flashShareInfo({ title: '  文件.zip  ' }).title, '文件.zip')
  const long = flashShareInfo({ title: '长'.repeat(200) })
  assert.equal(long.title.length, 120)
})

// ---------------------------------------------------------------------------
// extractFlashFileList / extractFlashDownloadUrls：防御式抽取
// ---------------------------------------------------------------------------

test('清单抽取：数组 / {files} / {data:{files}} / 单对象都能认', () => {
  const item = { file_name: 'a.zip', file_size: 2048 }
  for (const shape of [[item], { files: [item] }, { data: { files: [item] } }, { file_list: [item] }]) {
    const files = extractFlashFileList(shape)
    assert.equal(files.length, 1)
    assert.equal(files[0].name, 'a.zip')
    assert.equal(files[0].size, 2048)
  }
})

test('清单抽取：认不出返回空数组，不带垃圾名', () => {
  for (const bad of [undefined, null, {}, { files: 'x' }, [{ unknown: 1 }]]) {
    assert.deepEqual(extractFlashFileList(bad), [])
  }
})

test('下载直链抽取：数组 / 单 url 形状都认，没有 url 的条目被过滤', () => {
  const many = extractFlashDownloadUrls({ files: [{ name: 'a', url: 'https://x/1' }, { name: 'b' }] })
  assert.deepEqual(many.map((e) => e.name), ['a'])
  const single = extractFlashDownloadUrls({ url: 'https://x/2', file_name: 'c.bin' })
  assert.equal(single.length, 1)
  assert.equal(single[0].url, 'https://x/2')
})

// ---------------------------------------------------------------------------
// 展示层：清单与下载结果的文本
// ---------------------------------------------------------------------------

test('humanSize 分级正确', () => {
  assert.equal(humanSize(0), '')
  assert.equal(humanSize(512), '512B')
  assert.equal(humanSize(2048), '2KB')
  assert.equal(humanSize(5 * 1024 * 1024), '5.0MB')
})

test('清单文本：编号 + 体积 + 超量提示', () => {
  const text = formatFlashFileList([
    { name: 'a.zip', size: 2048 },
    { name: 'b.png', size: 0 },
    { name: 'c', size: 1 },
  ], { limit: 2 })
  assert.match(text, /1\. a\.zip（2KB）/)
  assert.match(text, /2\. b\.png$/m)
  assert.match(text, /还有 1 个没列出来/)
  assert.equal(formatFlashFileList([]), '')
})

test('下载结果文本：成功带路径、失败带原因，如实分开', () => {
  const text = formatFlashDownloadResult([
    { name: 'a.zip', path: '/w/flash/1-a.zip', bytes: 2048 },
    { name: 'b.iso', reason: '超过单次下载数量上限，这个文件没下载' },
  ])
  assert.match(text, /✓ a\.zip（2KB）→ \/w\/flash\/1-a\.zip/)
  assert.match(text, /✗ b\.iso：超过单次下载数量上限/)
})

// ---------------------------------------------------------------------------
// resolveFlashFileset / downloadFlashFileset：网关编排（注入 fake）
// ---------------------------------------------------------------------------

test('resolve：分享码换文件集 id，再拉清单；网关没给 id 时如实报错', async () => {
  const calls = []
  const onebot = {
    call: async (action, params) => {
      calls.push({ action, params })
      if (action === 'get_fileset_id') return { fileset_id: 'fs-1' }
      if (action === 'get_flash_file_list') return { files: [{ file_name: 'a.zip', file_size: 10 }] }
      return {}
    },
  }
  const r = await resolveFlashFileset({ onebot, shareCode: 'abcd1234' })
  assert.equal(r.filesetId, 'fs-1')
  assert.equal(r.files.length, 1)
  assert.deepEqual(calls.map((c) => c.action), ['get_fileset_id', 'get_flash_file_list'])

  const bad = { call: async () => ({}) }
  await assert.rejects(
    () => resolveFlashFileset({ onebot: bad, shareCode: 'abcd1234' }),
    /没认出这个分享码/,
  )
})

test('resolve：两个参数都不给就拒绝（绝不猜）', async () => {
  await assert.rejects(() => resolveFlashFileset({ onebot: { call: async () => ({}) } }), /share_code/)
})

test('download：拿到直链立刻逐个落盘，单文件失败不影响其余，超量如实标注', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flash-test-'))
  let n = 0
  const onebot = {
    call: async (action) => {
      if (action !== 'download_fileset') return {}
      n += 1
      return { files: [
        // base64:// 由 fetchImage 直接解码（网关直链下载同一条路径）
        { name: 'a.txt', url: 'base64://' + Buffer.from('hello').toString('base64') },
        // 立即拒绝连接的地址：单文件失败不能拖垮其余
        { name: 'bad.bin', url: 'http://127.0.0.1:1/bad' },
        { name: 'c.txt', url: 'base64://' + Buffer.from('world').toString('base64') },
      ] }
    },
  }
  const results = await downloadFlashFileset({ onebot, dir, filesetId: 'fs-1', maxFiles: 2 })
  assert.equal(results.length, 3, '三个文件都有交代')
  const ok = results.filter((r) => r.path)
  const badResults = results.filter((r) => r.reason)
  // maxFiles=2：只尝试前两个（a 成功、bad 失败），第三个如实标注超额未下载
  assert.equal(ok.length, 1, '只有 a.txt 落盘')
  assert.equal(ok[0].name, 'a.txt')
  assert.equal(badResults.length, 2, 'bad.bin 失败 + c.txt 超额，都要有交代')
  assert.deepEqual(badResults.map((r) => r.name), ['bad.bin', 'c.txt'])
  assert.match(badResults[1].reason, /超过单次下载数量上限/)
  assert.ok(n === 1, 'download_fileset 只调一次')
  // 内容核对：写进盘的就是解码后的字节
  const fs = await import('node:fs/promises')
  const a = results.find((r) => r.name === 'a.txt')
  assert.equal((await fs.readFile(a.path)).toString(), 'hello')
})
