// 一个聊天一个工作区会把宿主的工作区列表撑爆（2026-11-05 实测：3 个群就 3 条同名工作区）。
// 默认改成所有 QQ 会话共用主工作区；要按聊天隔离得在配置里显式打开 workspacePerChat。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HUB = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')
const CFG = readFileSync(join(ROOT, 'src/core/config.js'), 'utf8')

test('默认共用工作区，只有显式打开才按聊天建', () => {
  assert.match(HUB, /getConfig\(\)\.workspacePerChat === true/, '要用开关判断，不能无条件按 chatId 建目录')
  assert.match(HUB, /perChat \? chatWorkspaceDir\(chat\.chatId\) : workspaceDirOf\(getConfig\(\)\)/)
})

test('配置里这个开关默认关', async () => {
  const { normalize } = await import('../src/core/config.js')
  assert.equal(normalize({}).workspacePerChat, false)
  assert.equal(normalize({ workspacePerChat: true }).workspacePerChat, true)
  assert.match(CFG, /workspacePerChat: false/)
})

test('系统会话（后台任务）永远走主工作区', () => {
  assert.match(HUB, /!chat\.chatId\.startsWith\('system:'\)/, 'system 会话不建子目录')
})
