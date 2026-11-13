// 当前保留的运行旋钮：入站限流环境变量解析。
import test from 'node:test'
import assert from 'node:assert/strict'
import { ratelimitOptionsFromEnv } from '../src/kernel/mw-ratelimit.js'

test('限流旋钮：非法值不出现，回构造缺省；合法值原样传给当前核心', () => {
  const badCapacity = ['', 'abc', '-1', '0', 'NaN', '1e999', undefined]
  for (const bad of badCapacity) {
    const options = ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: bad })
    assert.ok(!('capacity' in options), `capacity 非法值 ${String(bad)} 不得出现`)
  }
  const badRefill = ['', 'abc', '-1', 'NaN', '1e999', undefined]
  for (const bad of badRefill) {
    const options = ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: bad })
    assert.ok(!('refillPerSec' in options), `refill 非法值 ${String(bad)} 不得出现`)
  }
  assert.equal(ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: '0' }).refillPerSec, 0)
  const valid = ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: '50', QQHUB_RL_REFILL_PER_SEC: '10' })
  assert.equal(valid.capacity, 50)
  assert.equal(valid.refillPerSec, 10)
})
