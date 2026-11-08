// 回归：/slang 路由在 1.3.61 里用了模块作用域不存在的 getConfig（应为 api.config），
// 接口 500「getConfig is not defined」，前端 catch 后静默显示「群白名单是空的」——误导排查方向。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('/slang 路由读白名单用的是 api.config（模块作用域没有裸 getConfig）', () => {
  // 2026-11-08：/slang 路由随模块化重构迁到独立模块 src/modules/slang/（URL 不变）
  const src = readFileSync(new URL('../src/modules/slang/index.js', import.meta.url), 'utf8')
  // /slang 路由体内不许出现裸 getConfig()
  const i = src.indexOf("api.route('/slang'")
  const seg = src.slice(i, i + 1400)
  assert.ok(!/[^.a-zA-Z]getConfig\(\)/.test(seg), '/slang 路由里还有裸 getConfig：' + seg.match(/[^.a-zA-Z]getConfig\(\)[^\n]*/)?.[0])
  assert.match(seg, /api\.config\(\)/, '配置经 api.config 读取')
})

test('全文件扫一遍：memory 与 slang 模块的路由里都不许有裸 getConfig（防同类错再犯）', () => {
  for (const file of ['../src/modules/memory/index.js', '../src/modules/slang/index.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    const lines = src.split('\n')
    lines.forEach((l, i) => {
      if (/[^.a-zA-Z]getConfig\(\)/.test(l)) assert.fail(`${file} 第 ${i + 1} 行裸 getConfig：${l.trim().slice(0, 80)}`)
    })
  }
  assert.ok(true)
})

test('前端空态不再吞接口错误：catch 要把错误暴露出来', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /黑话本读不到/, '接口失败要显示真实原因')
  assert.match(client, /const \[err, setErr\]/, '错误状态单独存')
})
