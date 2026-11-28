// 重构等价性守卫：拆分单体文件时，**对协作者模块的调用**不许丢。
//
// 为什么需要这条守卫
// ------------------
// 把 1000~2500 行的单体拆成多个子模块，最容易漏的不是导出符号（键集对比就能发现），
// 而是内部对**其它模块**的调用。真实事故（PR #273 拆分 memory-archive.js）：
//
//   · reload() 里 `learning?.reload?.()`  漏搬 —— 学习模块拿着重载前的旧快照继续跑
//   · dispose() 里 `vec.dispose()`         漏绑 —— 向量通道定时器与在飞 fetch 泄漏
//   · reload() 里 `if (health.ok)` 守卫    丢失 —— 档案损坏时 load()+save() 把坏数据坐实
//
// 这几处返回对象键集完全一致、单测也全绿；只有把「原单体 与 拆分后全部子模块」的
// 调用面做差集才暴露出来。
//
// 只追踪「协作者」，不追踪全部调用
// --------------------------------
// 早期版本把 `identifier.method(` 全量比对，结果被局部变量改名淹没
// （`disabledGroups.map(` → `(...).map(`、`g.cond(` → `pol.cond(`…），
// 一上来就报几十条假的「缺失」，守卫会立刻变成狼来了。
//
// 所以每个目标只用 `TRACK` 声明的**协作者对象名**过滤：这些是跨模块注入进来的
// 实例（vec / learning / store / outbox / agent / registry …）。它们一旦漏搬，
// 就是真实的功能或资源泄漏；而局部变量怎么改名都无所谓。
//
// 已知边界（如实记录）：这条守卫只能发现「方法调用消失」，**发现不了**
// 「条件判断丢失」（例如上面第 3 条 `if (health.ok)`）。那类要靠行为测试覆盖。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { callSurface } from './helpers/call-surface.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/refactor-parity-baseline.json'), 'utf8'))

/**
 * 每个重构目标：
 *   monolith      —— 拆分前唯一持有该逻辑的文件
 *   splitMarkers  —— 任意一个存在就认为「已拆分」，此时才启用 allowedMissing
 *   splitFiles    —— 拆分后实际持有该逻辑的文件（门面 + 子模块）
 *   track         —— 只比对这些接收者的调用（跨模块注入的协作者）
 *   allowedMissing—— 刻意改名/合并的调用，必须写明理由
 */
const TARGETS = [
  {
    name: 'memory',
    label: 'memory-archive.js（1746 行）→ state-session / index-cache / crud / derived / recall',
    monolith: ['src/features/memory-archive.js'],
    splitMarkers: ['src/features/memory-state-session.js'],
    splitFiles: [
      'src/features/memory-archive.js',
      'src/features/memory-state-session.js',
      'src/features/memory-index-cache.js',
      'src/features/memory-crud.js',
      'src/features/memory-derived.js',
      'src/features/memory-recall.js',
    ],
    track: ['vec', 'learning', 'store', 'reranker', 'session', 'indexCache', 'derived', 'crud', 'hub', 'chatLog'],
    allowedMissing: {
      'reranker.enabled': '改为 reranker.current.enabled()：装配顺序上 reranker 在 recall 之后才建，必须延迟取（memory-recall.js 的 const reranker = { current }）',
      'reranker.rerank': '改为 reranker.current.rerank()（同上）',
    },
  },
  {
    name: 'core',
    label: 'modular-core.js（2446 行）→ host/core/* + chat/dsh-turn-runner.js',
    monolith: ['src/host/modular-core.js'],
    splitMarkers: ['src/chat/dsh-turn-runner.js'],
    splitFiles: [
      'src/host/modular-core.js',
      'src/host/core/inbound-prep.js',
      'src/host/core/group-gate.js',
      'src/host/core/turn-failure.js',
      'src/host/core/prompt-context.js',
      'src/host/core/tools-mount.js',
      'src/host/core/session-lifecycle.js',
      'src/chat/dsh-turn-runner.js',
      // S3：入站水合链（合并转发/语音/文件/引用）从装配根搬出
      'src/chat/inbound-hydration.js',
      // S5：入站路由层与模型同步从装配根搬出
      'src/host/core/inbound-router.js',
      'src/host/core/model-sync.js',
    ],
    track: [
      'outbox', 'agent', 'controller', 'registry', 'groups', 'activity', 'turnStickers', 'participants',
      'assembly', 'replyDelivery', 'systemTurns', 'audio', 'onebot', 'dsh', 'chatLog', 'mods',
      'capture', 'faces', 'stickers', 'tts', 'interaction', 'presence', 'hub', 'inboundFiles',
      'inboundVision', 'promptVars',
    ],
    allowedMissing: {},
  },
  {
    // 纯函数文件：拆分前后都只有内置对象（String / Array / Object / JSON / 正则）参与，
    // 没有一个跨模块协作者 —— 所以没有可追踪的调用面。
    // 这类拆分的真实回归风险是「import 位置搬错」（如 migrateRawOnLoad 搬进 defaults），
    // 已由 test/hint-budget.test.js、test/workspace-shared.test.js 的静态读取覆盖。
    name: 'config',
    label: 'config.js（1013 行）→ config-defaults / normalizers / secrets / migrations（纯函数，无协作者调用面）',
    monolith: ['src/core/config.js'],
    splitMarkers: ['src/core/config-normalizers.js'],
    splitFiles: [
      'src/core/config.js', 'src/core/config-defaults.js', 'src/core/config-normalizers.js',
      'src/core/config-secrets.js', 'src/core/config-migrations.js',
    ],
    track: [],
    allowedMissing: {},
  },
  {
    // 同上：reply.js 是纯字符串/正则处理，无协作者。
    name: 'reply',
    label: 'reply.js（1187 行）→ reply-sanitize / markdown / document / segment（纯函数，无协作者调用面）',
    monolith: ['src/chat/reply.js'],
    splitMarkers: ['src/chat/reply-segment.js'],
    splitFiles: [
      'src/chat/reply.js', 'src/chat/reply-sanitize.js', 'src/chat/reply-markdown.js',
      'src/chat/reply-document.js', 'src/chat/reply-segment.js',
    ],
    track: [],
    allowedMissing: {},
  },
]

const readIfExists = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null)
const isSplit = (target) => target.splitMarkers.some((rel) => existsSync(join(ROOT, rel)))
const currentFiles = (target) => (isSplit(target) ? target.splitFiles : target.monolith).filter((rel) => existsSync(join(ROOT, rel)))

function currentSurface(target) {
  const out = new Set()
  for (const rel of currentFiles(target)) {
    for (const call of callSurface(readIfExists(rel) || '', target.track)) out.add(call)
  }
  return out
}

test('基线快照有效（防 fixture 被清空/损坏后守卫变成"永不失败"）', () => {
  for (const target of TARGETS) {
    const baseline = BASELINE[target.name]
    assert.ok(Array.isArray(baseline), `${target.name} 缺少基线`)
    assert.equal(new Set(baseline).size, baseline.length, `${target.name} 基线有重复项`)
    if (target.track.length) {
      assert.ok(baseline.length >= 10, `${target.name} 基线只有 ${baseline.length} 条，疑似被清空`)
      // 基线里每条都必须落在 track 范围内，否则说明 fixture 与 track 脱节
      for (const call of baseline) {
        assert.ok(target.track.includes(call.split('.')[0]), `${target.name} 基线里 ${call} 的接收者不在 track 列表内`)
      }
    } else {
      assert.equal(baseline.length, 0, `${target.name} 声明无协作者，基线必须为空`)
    }
  }
})

for (const target of TARGETS) {
  test(`重构等价：${target.label}`, (t) => {
    if (!target.track.length) {
      // 纯函数文件没有可追踪的协作者调用面：这里只确认门面还在 re-export（符号面由既有测试覆盖）。
      const files = currentFiles(target)
      assert.ok(files.length >= 1, `${target.name} 一个文件都没扫到`)
      t.diagnostic(`${target.name}：无可追踪协作者，跳过调用面比对`)
      return
    }

    const baseline = BASELINE[target.name]
    const surface = currentSurface(target)
    const allowed = isSplit(target) ? target.allowedMissing : {}
    const missing = baseline.filter((call) => !surface.has(call) && !(call in allowed))

    assert.deepEqual(
      missing,
      [],
      `拆分 ${target.name} 后这些协作者调用彻底消失了（说明某段逻辑漏搬）：\n`
      + missing.map((call) => `  · ${call}`).join('\n')
      + `\n\n如果某条是刻意的（改名/合并/删除死代码），请在 test/refactor-parity.test.js 的 `
      + `TARGETS 里 name==='${target.name}' 那一条的 allowedMissing 登记它并写明理由。`,
    )
  })
}

test('白名单不许腐烂：每条都必须在当前确实缺失，否则删掉它', () => {
  for (const target of TARGETS) {
    if (!Object.keys(target.allowedMissing).length) continue
    if (!isSplit(target)) continue
    const surface = currentSurface(target)
    const stale = Object.keys(target.allowedMissing).filter((call) => surface.has(call))
    assert.deepEqual(stale, [], `${target.name} 白名单里有条目其实还在被调用（改名回退或白名单过期）：\n`
      + stale.map((call) => `  · ${call}`).join('\n'))
  }
})

test('已拆分的目标必须真的扫到多个文件（防 splitFiles 写错导致守卫空转）', () => {
  for (const target of TARGETS) {
    if (!isSplit(target)) continue
    const files = currentFiles(target)
    assert.ok(files.length >= 2, `${target.name} 已拆分但只扫到 ${files.length} 个文件`)
    for (const rel of target.splitFiles) {
      assert.ok(existsSync(join(ROOT, rel)), `${target.name} 的 splitFiles 里 ${rel} 不存在`)
    }
  }
})