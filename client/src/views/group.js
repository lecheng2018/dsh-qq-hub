import { useState, h } from '../core/react.js'
import { Card, Row, Btn, ListInput, PercentRow, SectionNav, HelpDisclosure } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath } from '../core/utils.js'
import { OwnerBrief } from './access.js'

function Group({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  const overrides = draft.group.overrides || {}
  const [newGid, setNewGid] = useState('')
  return h('div', { className: 'ab-grid' },
    h(SectionNav, { items: [{ id: 'chat-rhythm', label: '回复节奏' }, { id: 'chat-bubbles', label: '消息分条' }, { id: 'chat-interject', label: '主动互动' }, { id: 'chat-safety', label: '安全与例外' }] }),
    h('section', { id: 'chat-rhythm', className: 'ab-grid ab-g2' },
      h(Card, { title: '连发合并', right: f.sw('merge.enabled'), summary: '等对方把连续消息说完，再统一回复。' },
        h(Row, { label: '私聊停顿' }, f.range('merge.waitSec', 0.5, 10, 0.5, (v) => v + ' 秒')),
        h(Row, { label: '私聊最长等待' }, f.range('merge.maxSec', 2, 30, 1, (v) => v + ' 秒')),
        h(Row, { label: '群聊停顿', hint: '群里多人连续发言时等待' }, f.range('merge.groupWaitSec', 1, 20, 1, (v) => v + ' 秒')),
        h(Row, { label: '群聊最长等待' }, f.range('merge.groupMaxSec', 3, 60, 1, (v) => v + ' 秒'))),
      h(Card, { title: '回合超时', summary: '模型或工具长时间不结束时释放等待。' },
        h(Row, { label: '最多等待', hint: '可设 1～120 分钟' },
          h('input', { className: 'ab-input sm', type: 'number', min: 1, max: 120, step: 1, value: Math.round((Number(draft.turnTimeoutMs) || 600000) / 60000), onChange: (e) => setDraft(setPath(draft, 'turnTimeoutMs', Number(e.target.value) * 60000)) }),
          h('span', { className: 'ab-muted' }, '分钟')),
        h(HelpDisclosure, null, '超时后的旧回复不会补发。发送下一条消息时会创建新会话，避免这个聊天一直排队。'))),
    h(Card, { id: 'chat-bubbles', title: '消息分条', summary: '控制单条消息长度和每轮消息数量。' },
      h(Row, { label: '群聊单条上限' }, f.num('reply.groupMaxChars', { min: 10, max: 500 }), h('span', { className: 'ab-muted' }, '字')),
      h(Row, { label: '私聊单条上限' }, f.num('reply.privateMaxChars', { min: 20, max: 2000 }), h('span', { className: 'ab-muted' }, '字')),
      h(Row, { label: '每轮最多条数', hint: '超出后均匀合并' }, f.num('reply.maxBubbles', { min: 1, max: 12 }), h('span', { className: 'ab-muted' }, '条')),
      h(Row, { label: '清单和汇报整段发', hint: '避免小标题、编号和代码块被拆散' }, f.sw('reply.keepReports')),
      h(HelpDisclosure, { label: '查看完整分条规则' }, '她写的 ||| 一定断开，空行算段落。普通句子按上面的长度上限聚合；一行一个要点的清单整段发送。连续短句可以按换行分条，过短的句子会先与相邻内容合并。')),
    h(Card, { id: 'chat-interject', title: '群里主动互动', summary: '没人叫她时，也可以按概率和话题相关度参与。' },
      h(Row, { label: '插话概率' }, f.percent('group.interjectChance')),
      h(Row, { label: '两次插话冷却' }, f.range('group.cooldownSec', 0, 600, 10, (v) => v + ' 秒')),
      h(Row, { label: '每小时上限' }, f.range('group.maxPerHour', 0, 30, 1, (v) => v + ' 次')),
      h(Row, { label: '感兴趣的话题', hint: '一行一个' }, f.list('group.interests', { placeholder: '游戏\n追剧\n白米饭' })),
      h(Row, { label: '话题相关度门槛', hint: '0 表示纯随机' }, f.range('group.minRelevance', 0, 1, 0.05, (v) => (v === 0 ? '不看话题' : Math.round(v * 100) + '%'))),
      h(Row, { label: '群冷清时不插话' }, f.num('group.minRecentMessages', { min: 0 }), h('span', { className: 'ab-muted' }, '条 /'), f.num('group.activeWindowSec', { min: 30 }), h('span', { className: 'ab-muted' }, '秒')),
      h(Row, { label: '静默时段', hint: '被叫到时仍会回复' },
        h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[0], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [Number(e.target.value), draft.group.quietHours[1]])) }),
        h('span', { className: 'ab-muted' }, '点 到'),
        h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[1], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [draft.group.quietHours[0], Number(e.target.value)])) }),
        h('span', { className: 'ab-muted' }, '点')),
      h(HelpDisclosure, { label: '加入话题后如何回复' }, '被叫到或主动插话后会暂时加入话题。话题仍相关且她 3 分钟内说过话时，可以继续回复，不受冷却和每小时上限限制；话题跑偏或她选择不说话时退出。')),
    h('section', { id: 'chat-safety', className: 'ab-grid' },
      h('div', { className: 'ab-section-title' }, '安全与例外'),
      h(OwnerBrief, { draft, setDraft }),
      h(Card, { title: '群里什么时候必回', summary: '被 @、引用回复或提到唤醒词时回复。' }, h(Row, { label: '唤醒词', hint: '一行一个' }, f.list('group.wakeWords', { placeholder: '大肥鱼\n肥鱼' }))),
      h(Card, { title: '发文件', right: f.sw('files.enabled'), summary: '允许主人私聊发送工作区和指定目录中的文件。' },
        h(Row, { label: '单个文件最大' }, f.num('files.maxMB', { min: 1, max: 2048 }), h('span', { className: 'ab-muted' }, 'MB')),
        h(Row, { label: '额外允许的目录', hint: '一行一个完整路径' }, f.list('files.dirs', { placeholder: 'D:\\Aurabot\\要发的文件' })),
        h(HelpDisclosure, { label: '文件发送范围' }, '可以发给白名单里的人或群。QQ 工作区始终允许，无需重复填写；发送记录会写入日志。')),
      h(Card, { title: '危险命令确认', right: f.sw('security.dangerConfirm'), summary: '执行致命终端命令前，先通过 QQ 私聊向主人确认。' },
        h(HelpDisclosure, { label: '哪些命令需要确认' }, '删除根目录、格式化、关机、下载后直接执行等命令需要回复「确认」；回复「取消」或 60 秒未回复会拦下。普通删除、构建和改文件不受影响。默认关闭。')),
      h(Card, { title: '安全刹车', summary: '短时间内在一个群里说得太多时暂停，主人 @ 除外。' },
        h(Row, { label: '触发上限' }, f.range('group.burstMax', 1, 20, 1, (v) => v + ' 次'), h('span', { className: 'ab-muted' }, '/'), f.range('group.burstWindowSec', 30, 600, 30, (v) => Math.round(v / 6) / 10 + ' 分钟'))),
      h(Card, { title: '同类 bot 防护', right: f.sw('group.fishGuard.enabled'), summary: '识别同类 bot 的来回对话，避免互相刷屏。', collapsible: true, defaultOpen: false },
        h(Row, { label: '按号码识别', hint: '逗号或空格隔开' }, h(ListInput, { value: (Array.isArray(draft.group.fishGuard.fishIds) ? draft.group.fishGuard.fishIds : []), placeholder: '123456789, 987654321', numbers: true, onChange: (list) => setDraft((prev) => setPath(prev, 'group.fishGuard.fishIds', list)) })),
        h(Row, { label: '按名字识别', hint: '补充默认名单之外的后缀' }, h(ListInput, { value: (Array.isArray(draft.group.fishGuard.nameSuffixes) ? draft.group.fishGuard.nameSuffixes : []), placeholder: '小鱼, 咸鱼罐头', onChange: (list) => setDraft((prev) => setPath(prev, 'group.fishGuard.nameSuffixes', list)) })),
        h(HelpDisclosure, { label: '防护机制与例外' }, '与确认是同类 bot 的对象互相接话 2 个来回后暂停；身份不明的对象 4 个来回后暂停。暂停这一对 30 分钟，不影响其他成员和主人。另有连续消息和占比的全局密度兜底。')),
      h(Card, { title: '按群单独设置', summary: '只覆盖指定群的插话概率。' },
        Object.keys(overrides).length === 0 ? h('div', { className: 'ab-muted', style: { marginBottom: 10 } }, '还没有单独设置的群。') : Object.entries(overrides).map(([gid, o]) => h(PercentRow, { key: gid, label: '群 ' + gid, value: o.interjectChance, fallback: draft.group.interjectChance,
          write: (v) => setDraft((prev) => { const cur = (prev.group.overrides || {})[gid] || {}; return setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [gid]: { ...cur, interjectChance: v } }) }),
          remove: () => setDraft((prev) => { const n = { ...(prev.group.overrides || {}) }; delete n[gid]; return setPath(prev, 'group.overrides', n) }) })),
        h('div', { className: 'ab-flex' }, h('input', { className: 'ab-input', placeholder: '群号', value: newGid, onChange: (e) => setNewGid(e.target.value.replace(/\D/g, '')) }), h(Btn, { small: true, disabled: !newGid, onClick: () => { setDraft((prev) => setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [newGid]: { interjectChance: prev.group.interjectChance } })); setNewGid('') } }, '添加')))),
  )
}

export { Group }
