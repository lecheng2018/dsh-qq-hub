// 蒸馏→人设卡 v4 测试：底卡=纯模板（数据目录 _voice-template.md 可编辑），蒸馏数据按
// 条件槽位语法（{{#field}}...{{items}}...{{/field}}）填卡；数据分类在 Extract、汇总在合并，
// 填卡是纯数据驱动的变量替换。模板与数据完全解耦。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dcard-'))
process.env.AURABOT_DATA_DIR = dir
mkdirSync(join(dir, 'personas'), { recursive: true })
writeFileSync(join(dir, 'personas', 'dafeiyu.md'), '---\nname: 大肥鱼\ntags: []\n---\n\n你是大肥鱼，住在 QQ 里的女孩子。\n\n【怎么说话：像人在打字】\n短句对仗。')
const dc = await import('../src/persona/distill-card.js')
const { distillCardId, voiceTemplate, identityOf, takeoverDecision, styleEntries, refreshDistillCard, loadTemplate, DEFAULT_TEMPLATE, TEMPLATE_FILE } = dc

const PROFILE = {
  exchanges: [{ text: '问：「号全封了吗」\n答：「空了好几天，我没看呢」', score: 1 }],
  syntax: [{ text: '长句靠逗号串，不分点', score: 0.8 }],
  catchphrases: [{ text: '斩（随口催办时）', score: 0.9 }, { text: '我瞅瞅（答应看一眼）', score: 0.8 }],
  rhetoric: [{ text: '被封号就自嘲', score: 0.7 }],
  never: [{ text: '从不说感谢、请问', score: 0.9 }],
  persona: [{ text: '热心答疑，谁问都回', score: 0.8 }],
  samples: [{ text: '毕竟是别人的卡，对你肯定没影响啊', score: 0.6 }], style: [], tone: [], avoid: [],
}
const ENTRIES = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: PROFILE }])

test('身份锚：取底卡第一个非空段落，截长保护；空卡给兜底', () => {
  assert.equal(identityOf('你是大肥鱼，住在 QQ 里的女孩子。\n\n【怎么说话】'), '你是大肥鱼，住在 QQ 里的女孩子。')
  assert.ok(identityOf('x'.repeat(200)).length <= 160)
  assert.ok(identityOf('').length > 0)
})

test('模板机制：首读释放内置默认到数据目录，之后读主人的版本', () => {
  const t1 = loadTemplate()
  assert.match(t1, /\{\{identity\}\}/, '默认模板带身份变量')
  assert.match(t1, /\{\{#catchphrases\}\}/, '条件槽位语法')
  assert.ok(existsSync(join(dir, 'personas', TEMPLATE_FILE)), '释放成文件')
  writeFileSync(join(dir, 'personas', TEMPLATE_FILE), '# 我的卡\n{{#syntax}}{{items}}{{/syntax}}', 'utf8')
  assert.equal(loadTemplate(), '# 我的卡\n{{#syntax}}{{items}}{{/syntax}}', '主人改的模板优先生效')
  // 还原成默认，后面测试用
  writeFileSync(join(dir, 'personas', TEMPLATE_FILE), DEFAULT_TEMPLATE, 'utf8')
})

test('填卡：数据按槽位填进模板，逐条列表展开，{{who}} 换对象名', () => {
  const body = voiceTemplate(ENTRIES, '你是大肥鱼，住在 QQ 里的女孩子。')
  assert.match(body, /# 身份\n\n你是大肥鱼，住在 QQ 里的女孩子。/, '身份变量填充')
  assert.match(body, /## 打字习惯（借自「炙心」）\n\n- 长句靠逗号串，不分点/, '语法槽+who')
  assert.match(body, /## 口头禅（借自「炙心」，什么时候用什么）\n\n- 斩（随口催办时）\n- 我瞅瞅（答应看一眼）/, '多条汇总成列表')
  assert.match(body, /## 接话方式（借自「炙心」，学应对方式，内容绝不照搬）\n\n- 问：「号全封了吗」/, '接话槽')
  assert.match(body, /## 绝不用（借自「炙心」的负向词表）\n\n- 从不说感谢、请问/, '负向槽')
  assert.match(body, /硬边界：只借说话方式，不借身份/, '边界保留')
  assert.doesNotMatch(body, /\{\{/, '无残留变量花括号')
  assert.equal(voiceTemplate([], 'x'), '', '无数据出空卡')
  assert.equal(voiceTemplate([{ name: '甲', profile: {} }], 'x'), '', '空画像不出卡')
})

test('条件槽位：某字段没数据 → 整节消失（模板骨架随数据伸缩）', () => {
  const slim = styleEntries([{ gid: '249729644', uid: '1', name: '炙心', profile: { catchphrases: [{ text: '斩（催办时）', score: 0.9 }] } }])
  const body = voiceTemplate(slim, '你是大肥鱼。')
  assert.match(body, /## 口头禅（借自「炙心」，什么时候用什么）\n\n- 斩（催办时）/)
  assert.doesNotMatch(body, /打字习惯/, 'syntax 空槽整节消失')
  assert.doesNotMatch(body, /校准原话/, 'samples 空槽整节消失')
})

test('主人自定义模板：措辞全由模板决定，数据只管填', () => {
  writeFileSync(join(dir, 'personas', TEMPLATE_FILE), '风格速查：{{#catchphrases}}{{items}}；{{/catchphrases}}完毕', 'utf8')
  const slim = styleEntries([{ gid: '249729644', uid: '1', name: '老王', profile: { catchphrases: [{ text: '斩', score: 0.9 }] } }])
  const body = voiceTemplate(slim, 'x')
  assert.match(body, /风格速查：- 斩；完毕/, '主人模板完全接管措辞')
  writeFileSync(join(dir, 'personas', TEMPLATE_FILE), DEFAULT_TEMPLATE, 'utf8')
})

test('接管判定：没指定过才接管；手动指定过绝不抢', () => {
  const cardId = distillCardId('249729644')
  const open = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  assert.equal(takeoverDecision(open, '249729644', cardId).takeover, true)
  const mine = { persona: { current: 'dafeiyu', groups: { '249729644': 'persona-gen2' } } }
  assert.equal(takeoverDecision(mine, '249729644', cardId).takeover, false)
  const already = { persona: { current: 'dafeiyu', groups: { '249729644': cardId } } }
  assert.equal(takeoverDecision(already, '249729644', cardId).takeover, true)
})

test('refresh 端到端：模板卡落盘、底卡不动、画像变化整卡重填', () => {
  const cfg = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  const r = refreshDistillCard({ gid: '249729644', entries: ENTRIES, cfg, log: { info: () => {} } })
  assert.equal(r.ok, true)
  const raw = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.match(raw, /name: 语感·借自炙心/)
  assert.match(raw, /# 身份\n\n你是大肥鱼，住在 QQ 里的女孩子。/, '身份锚来自底卡首段')
  assert.match(raw, /斩（随口催办时）/)
  const base = readFileSync(join(dir, 'personas', 'dafeiyu.md'), 'utf8')
  assert.doesNotMatch(base, /借自|打字习惯/, '底卡文件没被改写')
  // 画像变化 → 重填
  const cfg2 = { persona: { current: 'dafeiyu', groups: { '249729644': distillCardId('249729644') } } }
  const updated = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: { ...PROFILE, catchphrases: [{ text: '斩（随口催办时）', score: 0.9 }] } }])
  refreshDistillCard({ gid: '249729644', entries: updated, cfg: cfg2, log: { info: () => {} } })
  const raw2 = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.doesNotMatch(raw2, /我瞅瞅/, '删掉的口头禅不再出现')
  // 无画像拒绝
  const r2 = refreshDistillCard({ gid: '999', entries: [], cfg, log: { info: () => {} } })
  assert.equal(r2.ok, false)
})

test('内部模板文件不进人设列表、readPersona 不认', async () => {
  const { listPersonas, readPersona } = await import('../src/persona/personas.js')
  const ids = listPersonas().map((p) => p.id)
  assert.ok(!ids.includes('_voice-template'), '模板不是人设')
  assert.equal(readPersona('_voice-template'), null)
  assert.ok(ids.includes('persona-语感-249729644'), '派生卡在列表里')
})

test('接线：学习成功自动刷卡 + 路由 + setConfig 只在接管时发生', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.equal((mem.match(/onDistillLearned && await onDistillLearned/g) || []).length, 2)
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/card\/refresh'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /写进群人设卡/)
})
