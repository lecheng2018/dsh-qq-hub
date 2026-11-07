// 面板接口前缀：得跟着「DSH 被挂在哪」走。
// 报障现场：飞牛 App 里打开 DSH（网关把 DSH 挂在 /app/Harness/dsh/，页面注入了
// <base href="./">），面板提示「连不上插件：The string did not match the expected pattern.」。
// 真因是 client.js 里写死了 '/qq-hub/api'：请求掉出挂载点，打到门户根拿到 404 HTML，
// WebKit 解析 JSON 时就吐这句话。下面把两种挂载方式的解析结果都钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

function loadApiBaseFrom () {
  const m = src.match(/function apiBaseFrom \(href\) \{[\s\S]*?\n    \}/)
  assert.ok(m, 'client.js 里应该还有 apiBaseFrom')
  // 去掉 4 空格缩进后整体求值，避免依赖宿主上下文
  const body = m[0].replace(/\n {4}/g, '\n')
  return new Function('return (' + body + ')')()
}

function loadReadJson () {
  const m = src.match(/const readJson = \(r\) => r\.text\(\)\.then\(\(text\) => \{[\s\S]*?\n    \}\)/)
  assert.ok(m, 'client.js 里应该还有 readJson')
  const body = m[0].replace(/\n {4}/g, '\n').replace('const readJson = ', '')
  return new Function('return (' + body + ')')()
}

test('直连端口（站点根）时前缀不变', () => {
  const apiBaseFrom = loadApiBaseFrom()
  assert.equal(apiBaseFrom('http://127.0.0.1:13080/'), '/qq-hub/api')
  assert.equal(apiBaseFrom('http://127.0.0.1:13080/?token=abc'), '/qq-hub/api')
  assert.equal(apiBaseFrom('http://192.168.1.9:13080/#/session/1'), '/qq-hub/api')
})

test('网关子路径挂载时前缀跟着挂载点走（飞牛 App 的 /app/Harness/dsh）', () => {
  const apiBaseFrom = loadApiBaseFrom()
  assert.equal(apiBaseFrom('http://nas.local:5666/app/Harness/dsh/'), '/app/Harness/dsh/qq-hub/api')
  // 末尾没有斜杠、或者带 hash 路由，都得指向同一个挂载目录
  assert.equal(apiBaseFrom('http://nas.local:5666/app/Harness/dsh'), '/app/Harness/dsh/qq-hub/api')
  assert.equal(apiBaseFrom('http://nas.local:5666/app/Harness/dsh/#/session/1'), '/app/Harness/dsh/qq-hub/api')
  assert.equal(apiBaseFrom('http://nas.local:5666/app/Harness/dsh/index.html'), '/app/Harness/dsh/qq-hub/api')
})

test('解析不出 baseURI 时退回根路径，不把面板整个炸掉', () => {
  const apiBaseFrom = loadApiBaseFrom()
  assert.equal(apiBaseFrom('about:blank'), '/qq-hub/api')
  assert.equal(apiBaseFrom(''), '/qq-hub/api')
  assert.equal(apiBaseFrom(undefined), '/qq-hub/api')
})

test('服务器回 HTML/空响应时说人话，而不是 Safari 那句 expected pattern', async () => {
  const readJson = loadReadJson()
  const html = await readJson({ status: 404, text: async () => '<!doctype html><html><body><h1>飞牛 fnOS</h1></body></html>' })
  assert.equal(html.ok, false)
  assert.equal(html.status, 404)
  assert.match(html.message, /^HTTP 404：/)
  assert.match(html.message, /飞牛 fnOS/)
  assert.doesNotMatch(html.message, /<[^>]*>/, '消息里不该留 HTML 标签')

  const empty = await readJson({ status: 401, text: async () => '' })
  assert.equal(empty.ok, false)
  assert.match(empty.message, /HTTP 401：空响应/)

  const ok = await readJson({ status: 200, text: async () => '{"ok":true,"version":"1.3.49"}' })
  assert.deepEqual(ok, { ok: true, version: '1.3.49' })
})

test('client.js 里不再有写死的根路径接口', () => {
  assert.equal(/const API = '\/qq-hub\/api'/.test(src), false, 'API 前缀必须由 apiBaseFrom 推导')
})
