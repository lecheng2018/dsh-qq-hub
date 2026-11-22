// 面板「未保存」脏标记的结构性回归。
//
// page.js 的 tabDirty() 只认 TAB_KEYS 里列出的配置根，漏登记的表现是：改完不出现脏标记，
// 用户以为存上了，一关面板改动就静默丢失。files.maxMB / files.dirs / security.dangerConfirm
// 和连接页的 workspaceDir 就长期是这么漏的（2026-11-22 补登记）。
// 这里直接读视图源码，把「这一页能改哪些根」和 TAB_KEYS 对齐，新增控件漏登记时当场红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TAB_KEYS } from '../client/src/domain/tab-keys.js'

const view = (file) => readFileSync(new URL(`../client/src/views/${file}`, import.meta.url), 'utf8')

/** 该视图里用 f.num / f.sw / f.text … 编辑的配置根（'a.b.c' → 'a'） */
const rootsOf = (file) => [...new Set(
  [...view(file).matchAll(/f\.[a-z]+\('([A-Za-z][\w.]*)'/g)].map((match) => match[1].split('.')[0])
)].sort()

test('群聊页能改的配置根都登记在 TAB_KEYS.group（含发文件 / 收文件 / 危险命令确认）', () => {
  const missing = rootsOf('group.js').filter((root) => !TAB_KEYS.group.includes(root))
  assert.deepEqual(missing, [], '这些根没登记 → 改完不会出现未保存标记，关掉面板就丢了')
  // 反向兜个底：这两块确实在这一页，别因为将来挪走控件而让断言变空转
  assert.deepEqual(rootsOf('group.js').filter((root) => root === 'files' || root === 'security'), ['files', 'security'])
})

test('连接页能改的配置根都登记在 TAB_KEYS.connect（含 workspaceDir）', () => {
  const missing = rootsOf('connect.js').filter((root) => !TAB_KEYS.connect.includes(root))
  assert.deepEqual(missing, [], '这些根没登记 → 改完不会出现未保存标记，关掉面板就丢了')
  assert.ok(rootsOf('connect.js').includes('workspaceDir'), 'workspaceDir 应该还在连接页')
})
