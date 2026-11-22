// 审计 S07 的回归锁：日记素材按会话授权，配图按来源过滤。
//
// 原始问题：
//   · todayExcerpt 只排除 system 会话——主人私聊 + 所有白名单群的当天流水被混成
//     一份 60 行摘要交给模型，再以第一人称公开发到空间（visibility 默认 all）。
//   · pickDiaryImage 只按日期挑图，不看来源——表情库里 197/230 条是从别人群里
//     收集的，会被配到公开发布的说说上。
//
// 修复：diary.includeChats（默认空 = 不引用任何聊天）+ visibility 默认 self +
// 配图按「她自己的画作永远可用；别人会话来的表情需该会话已授权」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'qqhub-diary-s07-'))
process.env.AURABOT_DATA_DIR = DIR

const { normalize } = await import('../src/core/config.js')
const { createQzone } = await import('../src/features/qzone.js')
const { dataDir, writeJson } = await import('../src/core/store.js')

const noopLog = { info() {}, debug() {}, warn() {} }
const dayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 假流水：三条来自不同会话，一条来自 system。 */
function fakeChatLog() {
  const now = Date.now()
  return {
    readDay: () => [
      { t: now, chatId: 'private:900000004', who: '主人', text: '我今天在私聊里说了机密A' },
      { t: now, chatId: 'group:900000003', who: '群友甲', text: '群里聊了事情B' },
      { t: now, chatId: 'group:900000002', who: '群友乙', text: '另一个群的事C' },
      { t: now, chatId: 'system:diary', who: '系统', text: '系统流水D' },
    ],
  }
}

/** 抓 prompt：用假 hub.runSystemTurn 记录传给模型的内容。 */
function makeQzone(cfg) {
  const prompts = []
  const posted = []
  const qzone = createQzone({
    getConfig: () => cfg,
    onebot: { call: async () => ({}) },
    chatLog: fakeChatLog(),
    log: noopLog,
    hub: {
      chatLogOf: () => [],
      runSystemTurn: async (_name, _title, prompt) => { prompts.push(String(prompt)); return '今天挺好' },
      deliver: async () => true,
    },
    onDiary: () => {},
    pickImage: async () => '',
  })
  return { qzone, prompts, posted }
}

test('S07 · includeChats 为空：日记素材不引用任何聊天', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, diary: { includeChats: [] } })
  const { qzone, prompts } = makeQzone(cfg)
  await qzone.writeDiary({})
  assert.equal(prompts.length, 1)
  const prompt = prompts[0]
  for (const leaked of ['机密A', '事情B', '事情C', '流水D']) {
    assert.ok(!prompt.includes(leaked), `未授权时素材不得包含「${leaked}」：\n${prompt}`)
  }
  assert.match(prompt, /今天还没怎么聊天/, '没有素材时应走「没怎么聊天」分支')
})

test('S07 · 只授权一个群：只取该群流水，私聊与其它群都不进素材', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, diary: { includeChats: ['group:900000003'] } })
  const { qzone, prompts } = makeQzone(cfg)
  await qzone.writeDiary({})
  const prompt = prompts[0]
  assert.ok(prompt.includes('事情B'), '已授权群的流水应进素材')
  for (const leaked of ['机密A', '事情C', '流水D']) {
    assert.ok(!prompt.includes(leaked), `未授权内容不得出现：「${leaked}」`)
  }
})

test('S07 · system 会话即使被写进 includeChats 也不进素材', () => {
  const cfg = normalize({ enabled: true, diary: { includeChats: ['system:diary'] } })
  assert.deepEqual(cfg.diary.includeChats, [], '非法 chatId 在归一化阶段就被丢弃')
})

test('S07 · 可见范围默认仅自己可见（非法值安全回退到 self）', () => {
  assert.equal(normalize({}).diary.visibility, 'self', '新装默认 self，不再默认公开')
  assert.equal(normalize({ diary: { visibility: 'invalid' } }).diary.visibility, 'self', '非法值应 fail-closed 回退到 self，不得回退到 all')
  assert.equal(normalize({ diary: { visibility: 'friends' } }).diary.visibility, 'friends', '合法值正常保留')
})

test('S07 · includeChats 归一化：去重、丢弃非法、上限 100', () => {
  const c = normalize({ diary: { includeChats: ['group:1', 'group:1', 'nope', 'private:2', 42, 'group:abc'] } })
  assert.deepEqual(c.diary.includeChats, ['group:1', 'private:2'])
  const many = Array.from({ length: 150 }, (_, i) => `group:${i + 1}`)
  assert.equal(normalize({ diary: { includeChats: many } }).diary.includeChats.length, 100)
})

// ---------- 配图来源 ----------

test('S07 · 配图：未授权来源的表情不会被选中，她自己的画作仍然可用', async () => {
  const { pickDiaryImage } = await import('../src/features/diary-image.js')
  const { loadLibrary, stickerPath } = await import('../src/features/stickers.js')
  const { listPaintings } = await import('../src/features/paintings.js')

  // 造一个今天从「未授权群」收的表情
  const sDir = dataDir('stickers')
  mkdirSync(sDir, { recursive: true })
  writeFileSync(join(sDir, 'collected-x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  writeJson(join(sDir, 'index.json'), {
    items: [{ md5: 'x', file: 'collected-x.jpg', name: '', tags: [], from: 'group:999999', at: Date.now(), width: 100, height: 100, bytes: 4 }],
  })
  // 确认这个表情确实在库里（前置事实）
  assert.ok(loadLibrary().items.some((i) => i.from === 'group:999999'), '夹具应有一条未授权来源的表情')

  const none = pickDiaryImage({ allowedChats: [] })
  assert.equal(none, '', '未授权来源的表情不应被选中（没有画作时返回空）')

  const allowed = pickDiaryImage({ allowedChats: ['group:999999'] })
  assert.equal(allowed, stickerPath(loadLibrary().items[0]), '授权后该表情可用')

  // 画作永远可用（与授权无关）。listPaintings 直接扫目录、at 取文件 mtime，
  // 不需要额外索引文件——第一版多写了一个 index.json，属于对实现的误解。
  const pDir = dataDir('imagegen') // 画作目录叫 imagegen（paintings.dir() 的实现细节）
  mkdirSync(pDir, { recursive: true })
  writeFileSync(join(pDir, 'p1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.ok(listPaintings({ limit: 5 }).items.length > 0, '夹具应有画作')
  assert.notEqual(pickDiaryImage({ allowedChats: [] }), '', '画作不依赖会话授权')
})
