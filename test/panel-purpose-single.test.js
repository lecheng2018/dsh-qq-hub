// 目的引擎的设置在面板里只能出现一次。
// 曾经有两套：client.js 里一张手写卡片，purpose 模块又通过 tab:'speakup' 渲染一份，
// 打开「主动搭话」页会看到两个「目的引擎（实验）」卡，两边的开关还互相不同步。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT = join(process.cwd(), 'client', 'client.js')
const src = readFileSync(CLIENT, 'utf8')

test('面板源码里不该再手写「目的引擎」卡片（设置由 purpose 模块的 settings 统一渲染）', () => {
  const hits = src.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => line.includes('目的引擎'))
  // 允许出现在注释里说明，但不允许出现卡片标题那种 h(Card, { title: '目的引擎…' })
  const cards = hits.filter(([, line]) => /h\(Card[^)]*title:\s*['"]目的引擎/.test(line))
  assert.deepEqual(cards, [], `面板里仍有手写的目的引擎卡片：${JSON.stringify(cards)}`)
})

test('purpose 模块自己声明了 tab=speakup 与四个设置项（面板从这里渲染）', () => {
  const mod = readFileSync(join(process.cwd(), 'src', 'modules', 'purpose', 'index.js'), 'utf8')
  assert.match(mod, /tab:\s*'speakup'/, '模块要挂在「主动搭话」页')
  for (const key of ['enabled', 'minMaterials', 'initialDelayMinutes', 'maxCandidates']) {
    assert.ok(mod.includes("key: '" + key + "'") || mod.includes('key: "' + key + '"'), `缺少设置项 ${key}`)
  }
})

test('后端 /panel/purpose/* 代理仍然保留', () => {
  // host.js 分层拆分后：/panel/purpose/* 路由在 panel/routes-purpose.js
  const host = readFileSync(join(process.cwd(), 'src', 'host', 'panel', 'routes-purpose.js'), 'utf8')
  for (const r of ['/panel/purpose/status', '/panel/purpose/preview', '/panel/purpose/run', '/panel/purpose/config']) {
    assert.ok(host.includes(r), `路由 ${r} 不能删，前端还有地方在用`)
  }
})
