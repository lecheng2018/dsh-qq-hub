// topicScore 的长度诚实性（真机刷屏的第三根导火索）。
//
// 旧算法 `score/3` 把 BM25 总分直接除以常数——BM25 总分随查询长度增长，
// 而群闸传进来的查询是**最近 6 条消息的拼接**（上百个字组）。结果是：
// 无关闲聊随便蹭几个常用字，分数照样饱和到 1.0，面板上相关度恒 0.50，
// engaged 入场券与插话提权全被这个假「相关」撑开。
//
// 新算法：罕见度加权的双向覆盖率（W/Q + W/D），与查询长度无关。
// 本文件钉住「长查询不得虚高、真话题不得误杀」这对双向指标。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tscore-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

async function storeWith(mems) {
  const { createMemoryStore } = await import('../src/features/memory.js')
  const store = createMemoryStore({
    dsh: {}, hub: {}, log: { info() {}, warn() {}, debug(){} },
    getConfig: () => ({ ownerQQ: '1000', persona: { current: 'dafeiyu' }, memory: { enabled: true } }),
    personaText: () => '',
  })
  for (const m of mems) store.add({ scope: 'group:777', chatId: 'group:777', ...m })
  return store
}
const G = { chatId: 'group:777', kind: 'group', groupId: '777' }

test('无关的长拼接查询：相关度不得饱和（旧算法恒 ~1.0 的病根）', async (t) => {
  sandbox(t)
  const store = await storeWith([
    { text: '主人说工作累靠咖啡续命，工位续航全靠冰美式' },
    { text: '主人家里养了只橘猫，最近老吐毛球' },
  ])
  const 无关长闲聊 = Array.from({ length: 6 }, (_, i) =>
    `排队好多人${i} 快递到了没有 中午吃什么 手机没电了 这游戏又更新了 群主发个红包`).join(' ')
  const score = store.topicScore(无关长闲聊, G)
  assert.ok(score < 0.5, `无关长查询不该给高相关度（实际 ${score.toFixed(3)}，旧算法≈1.0）`)
})

test('真话题混在长闲聊里：要认出来（不能修过头把真相关也压死）', async (t) => {
  sandbox(t)
  const store = await storeWith([
    { text: '主人说工作累靠咖啡续命，工位续航全靠冰美式' },
    { text: '主人家里养了只橘猫，最近老吐毛球' },
  ])
  const 混入猫话题 = ['排队好多人 快递到了没有', '中午吃什么',
    '有人家里养橘猫吗 我家这只最近老吐毛球 愁死人了', '手机没电了', '群主发红包'].join(' ')
  const score = store.topicScore(混入猫话题, G)
  assert.ok(score > 0.15, `真话题被长闲聊稀释后仍要 >0.15（实际 ${score.toFixed(3)}）`)
})

test('查询长度不改变方向性：同一话题，长拼接查询不得比短查询更高分', async (t) => {
  sandbox(t)
  const store = await storeWith([{ text: '主人说工作累靠咖啡续命，工位续航全靠冰美式' }])
  const 短 = store.topicScore('咖啡续命', G)
  const 长 = store.topicScore(['咖啡续命', ...Array.from({ length: 30 }, (_, i) => `无关水贴内容${i} 哈哈哈 顶一下`)].join(' '), G)
  assert.ok(短 >= 长, `短查询 ${短.toFixed(3)} 应 >= 稀释后的长查询 ${长.toFixed(3)}（旧算法反而长的高）`)
  assert.ok(短 > 0.5, '正中记忆主题的短查询应该高分')
})

test('常用字偶然重叠撑不起分数（nbcs 蹭「关心」的场景）', async (t) => {
  sandbox(t)
  const store = await storeWith([{ text: 'nbcs：nobody cares 缩写，没人关心、无奈' }])
  const 无关长聊 = Array.from({ length: 6 }, (_, i) =>
    `今天好多人关心我买不买奶茶啊 哈哈 群主呢 发红包发红包 排队排队午饭午饭${i}`).join(' ')
  const score = store.topicScore(无关长聊, G)
  assert.ok(score < 0.5, `偶然蹭词不该高分（实际 ${score.toFixed(3)}）`)
})

test('无命中/空查询/坏输入都返回 0，不抛', async (t) => {
  sandbox(t)
  const store = await storeWith([{ text: '主人家里养了只橘猫' }])
  assert.equal(store.topicScore('完全无关的火星话', G), 0)
  assert.equal(store.topicScore('', G), 0)
  assert.equal(store.topicScore('猫'), 0, '不传 chat 依旧 fail-closed')
})
