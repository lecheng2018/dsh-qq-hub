// 回归（平台出站安全与诚实计数）：
// ① 空间评论被身份闸拦下不再记成已评论/占次数（行为级）
// ② 小黑盒发帖配图：目录限制 + 图片魔数校验（结构锁）
// ③ 抖音公开评论/分享私信接出站身份闸（结构锁）
// ④ B站评论/回复被拦或试运行不再计数 —— 已随实现迁到商店模块，在那边做行为级用例
// ⑤ QQ 换头像网址过 SSRF 校验（结构锁）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const { createQzoneSocial } = await import('../src/features/qzone-social.js')

const noopLog = { info() {}, warn() {}, debug() {} }

function qzoneHarness(commentText) {
  process.env.DSH_QQ_HUB_DATA_DIR = mkdtempSync(join(tmpdir(), 'qzone-safety-'))
  const calls = []
  const events = []
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '10001', botQQ: '10002', ownerName: '主人',
    security: { identityGuard: { enabled: true, mode: 'block' } },
    qzoneSocial: { enabled: true, commentFriends: true, replyOwn: false, like: false, friendChance: 1, ownerChance: 1, maxPerDay: 10, intervalMin: 30 },
    speakUp: { awakeFrom: 0, awakeTo: 24 },
  }
  const feed = { appid: 311, key: 't1', uin: '30003', nickname: '好友', html: '<p>今天天气不错</p>', time: Math.floor(Date.now() / 1000) }
  const onebot = {
    async call(action, params) {
      calls.push({ action, params })
      if (action === 'get_qzone_feeds') return { feeds: [feed] }
      if (action === 'get_qzone_msg_detail') return { content: '今天天气不错', comments: [] }
      return {}
    },
  }
  const hub = { selfId: '10002', runSystemTurn: async () => commentText, logChat() {} }
  const social = createQzoneSocial({ getConfig: () => cfg, onebot, hub, chatLog: { append() {} }, log: noopLog, memory: { addEvent: (e) => events.push(e) } })
  return { social, calls, events }
}

test('空间评论：被身份闸拦下 → 不计数、不记记忆、不调 comment_qzone', async () => {
  const { social, calls, events } = qzoneHarness('主人的QQ是10001哦')
  const r = await social.run({ force: true })
  assert.equal(r.comments, 0, '被拦下不应算成已评论（旧版 done++ 照加）')
  assert.equal(events.length, 0, '被拦下不应记「评论了」的记忆')
  assert.ok(!calls.some((c) => c.action === 'comment_qzone'), '被拦下不应真发评论')
})

test('空间评论：正常评论 → 计数、记记忆、真发', async () => {
  const { social, calls, events } = qzoneHarness('今天天气真不错呀')
  const r = await social.run({ force: true })
  assert.equal(r.comments, 1, '正常评论应计数')
  assert.ok(events.length >= 1, '正常评论应记记忆')
  assert.ok(calls.some((c) => c.action === 'comment_qzone'), '正常评论应真发')
})

// ---- 结构锁：closure 内部的安全接线（行为级驱动成本高，按仓内 outbound-guard 惯例锁源码） ----
// 小黑盒发帖配图：魔数与目录校验行为级用例已随实现搬到商店模块（modules/heybox/module.test.mjs）。
const DOUYIN = SRC('../src/douyin/duty.js')
const PROFILE = SRC('../src/modules/profile/index.js')

test('抖音：公开评论经 doWrite 过身份闸，分享私信过身份闸', () => {
  assert.match(DOUYIN, /import \{ guardOutbound \} from '\.\.\/chat\/identity-guard\.js'/, '应引入身份闸')
  assert.match(DOUYIN, /if \(meta\.text && !guard\(meta\.text/, 'doWrite 评论正文过闸')
  assert.match(DOUYIN, /if \(!guard\(say, '私信'\)\)/, '分享私信过闸')
})

// B 站「被拦 / 试运行不计数」的行为级用例跟着实现搬到了商店模块（modules/bili/duty.test.mjs）。
test('QQ 换头像：网址先过 assertPublicUrl 再交给网关', () => {
  assert.match(PROFILE, /import \{ segmentBytes, assertPublicUrl \} from '\.\.\/\.\.\/core\/net\.js'/, '应引入 assertPublicUrl')
  assert.match(PROFILE, /await assertPublicUrl\(src\.file\)/, '头像网址过 SSRF 校验')
})