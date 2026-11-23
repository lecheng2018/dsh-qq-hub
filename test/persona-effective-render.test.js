// 回归（2026-11-23 真机「换人设/分群人设好像都没用」）：
// 人设是在**建会话那一刻**渲染进系统提示词的，DSH 之后不重算。于是有两种失效：
//   1. 卡 id 没变、正文改了 —— 旧的守卫只比 personaId，永远等不到重建；
//   2. 分群/群默认写了却没生效 —— 期望值取自哪一层、会话里到底固化了哪一版，全都看不见。
// 这个文件钉住两件事：正文指纹要能判出「同一张卡的旧版本」；期望值的来源要能说清（含空值行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'qqhub-persona-hash-'))
process.env.DSH_QQ_HUB_DATA_DIR = home

const { savePersona, personaHash, personaTarget } = await import('../src/persona/personas.js')
const { personaSourceOf } = await import('../src/host/panel/routes-persona.js')

test('正文指纹：同一版正文稳定，改正文就变（改 name/tags 不变）', () => {
  savePersona('t-hash', { name: '甲', tags: ['x'], body: '你是甲，说话很短。' })
  const h1 = personaHash('t-hash')
  assert.match(h1, /^[0-9a-f]{12}$/, '指纹是 12 位十六进制')
  assert.equal(personaHash('t-hash'), h1, '没改文件时指纹稳定（走 mtime+size 缓存）')

  // 只改卡头（name/tags）：正文没变，指纹必须一样 —— 否则改个名字就白重建一次会话
  savePersona('t-hash', { name: '乙', tags: ['y'], body: '你是甲，说话很短。' })
  assert.equal(personaHash('t-hash'), h1, '只改头部不该触发重建')

  // 改正文：指纹必须变，守卫才会重建
  savePersona('t-hash', { name: '乙', tags: ['y'], body: '你是乙，说话更短。' })
  assert.notEqual(personaHash('t-hash'), h1, '正文变了指纹必须变')
})

test('正文指纹：卡不存在返回空串，不抛', () => {
  assert.equal(personaHash('没有这张卡'), '')
  assert.equal(personaHash(''), '')
  assert.deepEqual(personaTarget('没有这张卡'), { id: '没有这张卡', hash: '' })
})

test('期望值来源：专卡 > 群/私聊默认 > 全局；空值行显式标出来', () => {
  const cfg = {
    persona: {
      current: 'p-global',
      groupDefault: 'p-group-def',
      privateDefault: 'p-priv-def',
      privates: { '10001': 'p-owner', '10002': '' },
      groups: { '777': 'p-group', '888': '' },
    },
  }
  assert.deepEqual(personaSourceOf({ kind: 'group', groupId: '777' }, cfg), { level: 'group', explicit: true })
  // 空值行：面板上「加了一行但没选卡」，实际走群默认 —— 必须能标出来，否则就是「配了没用」
  assert.deepEqual(personaSourceOf({ kind: 'group', groupId: '888' }, cfg), { level: 'groupDefault', emptyRow: true })
  assert.deepEqual(personaSourceOf({ kind: 'group', groupId: '999' }, cfg), { level: 'groupDefault' })
  assert.deepEqual(personaSourceOf({ kind: 'private', userId: '10001' }, cfg), { level: 'private', explicit: true })
  assert.deepEqual(personaSourceOf({ kind: 'private', userId: '10002' }, cfg), { level: 'privateDefault', emptyRow: true })
  const noDefaults = { persona: { current: 'p-global', privates: {}, groups: {} } }
  assert.deepEqual(personaSourceOf({ kind: 'group', groupId: '999' }, noDefaults), { level: 'global' })
})

test('清理临时数据目录', () => {
  rmSync(home, { recursive: true, force: true })
})

test('面板与接口：有自检卡片、能一键重建过期会话、空值行明说跟随默认', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const ROUTES = readFileSync(join(ROOT, 'src/host/panel/routes-persona.js'), 'utf8')
  const VIEW = readFileSync(join(ROOT, 'client/src/views/persona.js'), 'utf8')

  assert.match(ROUTES, /route\('\/persona\/audit'/, '自检接口要在')
  assert.match(ROUTES, /route\('\/persona\/rebuild-stale'/, '重建过期会话的接口要在')
  // 默认只出清单，要真动手得显式 dryRun:false —— 归档会话是不可逆的副作用
  assert.match(ROUTES, /const dryRun = body\.dryRun !== false/, '默认 dryRun')
  // 指纹是猜的（assumed）不许跟着一起重建
  assert.match(ROUTES, /entry\?\.personaHashAssumed === true/, 'assumed 要单独列')
  assert.match(ROUTES, /if \(row\.assumed && !includeAssumed\)/, 'assumed 默认不动')

  assert.match(VIEW, /function PersonaAudit/, '面板要有人设自检卡片')
  assert.match(VIEW, /get\('\/persona\/audit'\)/, '卡片要真的去拿自检数据')
  assert.match(VIEW, /post\('\/persona\/rebuild-stale'/, '卡片要能触发重建')
  // 空值行：面板上必须写清「没选卡 = 跟随默认」，否则就是「配了没用」的现场
  assert.match(VIEW, /跟随.*默认/, '空值行要提示跟随默认')
})
