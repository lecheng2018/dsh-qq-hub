// M1-E 灰度开关安全姿态（modular 重构阶段任务书 M1-E）
//
// 锁定全部灰度开关的默认姿态与 fail-closed 语义：
//   1. 所有开关未设置 / 空串 / 乱值 = 关（回 legacy 已验证路径，非法值绝不半开）；
//      解析契约（mw-* 头注）：'true'/'1' 忽略大小写与首尾空白，'TRUE ' 这类算开。
//   2. 以下只覆盖仍被独立测试使用的中间件工具；旧生产开关不再接入 host。
//   3. 限流旋钮非法值「键不出现」→ 工厂解构落到构造缺省（30/5），不抛错不放大；
//      refill=0 是合法的「极端闸」（文档明示），不是非法值；
//   4. 切换不双发：开关只接管 host.js 的实时事件流装配，装配期一次性读取（改 env 需重启），
//      flag-off 与基线路径逐字等价（该等价性由 e2e 与 kernel-* 套件在默认关姿态下持续背书）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { isEgressShadowEnabled } from '../src/kernel/ctx-store.js'
import { isIngressAggregatorEnabled } from '../src/kernel/mw-aggregator.js'
import { isNewMemoryPipelineEnabled } from '../src/kernel/mw-memory.js'
import { ratelimitOptionsFromEnv } from '../src/kernel/mw-ratelimit.js'

const OFF_CASES = [undefined, '', 'false', '0', 'on', '1.0', '01', null, ' yes']
// 只有 trim+lowercase 后恰为 'true'/'1' 才算开（'yes'/'on' 都不是）
const ON_CASES = ['true', '1', 'True', 'TRUE ', '\t1']

test('FLAG_EGRESS_SHADOW：默认 live；仅显式 true/1 才 shadow（host.js 装配位还要求管道先开）', () => {
  for (const v of OFF_CASES) assert.equal(isEgressShadowEnabled({ FLAG_EGRESS_SHADOW: v }), false, `值 ${String(v)} 必须 live`)
  for (const v of ON_CASES) assert.equal(isEgressShadowEnabled({ FLAG_EGRESS_SHADOW: v }), true, `值 ${String(v)} 必须开`)
})

test('FLAG_INGRESS_AGGREGATOR：默认关（暂停版 aggregator 不得在旧核心上恢复吞并）', () => {
  for (const v of OFF_CASES) assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: v }), false, `值 ${String(v)} 必须关`)
  for (const v of ON_CASES) assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: v }), true, `值 ${String(v)} 必须开`)
})

test('NEW_MEMORY_PIPELINE：默认关（memory takeover 未完整，不得扩大灰度）', () => {
  for (const v of OFF_CASES) assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: v }), false, `值 ${String(v)} 必须关`)
  for (const v of ON_CASES) assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: v }), true, `值 ${String(v)} 必须开`)
})

test('限流旋钮：非法值「键不出现」回构造缺省（30 突发 + 5/s 持续），不抛错不放大', () => {
  const badCapacity = ['', 'abc', '-1', '0', 'NaN', '1e999', undefined]
  for (const bad of badCapacity) {
    const o = ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: bad })
    assert.ok(!('capacity' in o), `capacity 非法值 ${String(bad)} 不得出现在结果里`)
  }
  const badRefill = ['', 'abc', '-1', 'NaN', '1e999', undefined]
  for (const bad of badRefill) {
    const o = ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: bad })
    assert.ok(!('refillPerSec' in o), `refill 非法值 ${String(bad)} 不得出现在结果里`)
  }
  // refill=0 是文档明示的合法「极端闸」
  assert.equal(ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: '0' }).refillPerSec, 0)
  const ok = ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: '50', QQHUB_RL_REFILL_PER_SEC: '10' })
  assert.equal(ok.capacity, 50)
  assert.equal(ok.refillPerSec, 10)
})

test('开关清单与默认值（M1-E 证据：与 docs/refactor/flags.md 一致，缺省全关）', () => {
  // 四个灰度位缺省全关；谁要扩大灰度改这里就是改姿态，必须走会签
  const env = {}
  assert.equal(isEgressShadowEnabled(env), false)
  assert.equal(isIngressAggregatorEnabled(env), false)
  assert.equal(isNewMemoryPipelineEnabled(env), false)
})
