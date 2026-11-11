import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, ListInput, PercentRow } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath } from '../core/utils.js'

function Group({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  const overrides = draft.group.overrides || {}
  const [newGid, setNewGid] = useState('')
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '连发合并', right: f.sw('merge.enabled'), desc: '人常常一口气发好几句。打开后她会等对方说完再一起回，而不是一句一回。' },
      h(Row, { label: '对方停顿多久算说完' }, f.range('merge.waitSec', 0.5, 10, 0.5, (v) => v + ' 秒')),
      h(Row, { label: '最多等多久', hint: '对方一直在发也最多等这么久' }, f.range('merge.maxSec', 2, 30, 1, (v) => v + ' 秒')),
      h(Row, { label: '群里停顿多久算一段', hint: '群里大家你一句我一句，多等一会儿把一段话攒齐再回；她回上一段的时候，新消息也会先攒着' }, f.range('merge.groupWaitSec', 1, 20, 1, (v) => v + ' 秒')),
      h(Row, { label: '群里最多等多久' }, f.range('merge.groupMaxSec', 3, 60, 1, (v) => v + ' 秒')),
    ),
    h(Card, { title: '回合超时', desc: '模型或工具长时间不结束时，停止等待并提示你，避免这个聊天一直排队。超时的旧回复不会补发；你发下一条消息时会新建会话。' },
      h(Row, { label: '最多等待', hint: '长报告可适当调大；可设 1～120 分钟' },
        h('input', { className: 'ab-input sm', type: 'number', min: 1, max: 120, step: 1, value: Math.round((Number(draft.turnTimeoutMs) || 600000) / 60000), onChange: (e) => setDraft(setPath(draft, 'turnTimeoutMs', Number(e.target.value) * 60000)) }),
        h('span', { className: 'ab-muted' }, ' 分钟')),
    ),
    h(Card, { title: '说话的样子（怎么分条）', desc: '分条全走规则，不再多问一次模型。她写的 ||| 一定断开；空行算段落；句末标点会按下面的上限攒成条。换行不代表换消息，一行一个要点的排版会攒成一条发；她真的一行一句话（每行都很短）时，换行就是分条。句子太短不会单独成条，攒够一截才断。' },
      h(Row, { label: '群里一条最长', hint: '攒到这么长就断开；正常聊天她一般写得比这短' }, f.num('reply.groupMaxChars', { min: 10, max: 500 }), h('span', { className: 'ab-muted' }, ' 字')),
      h(Row, { label: '私聊一条最长', hint: '私聊可以整段说，设大一点更像正常聊天' }, f.num('reply.privateMaxChars', { min: 20, max: 2000 }), h('span', { className: 'ab-muted' }, ' 字')),
      h(Row, { label: '一轮最多几条', hint: '超过就均匀合并，不会把剩下的全塞进最后一条' }, f.num('reply.maxBubbles', { min: 1, max: 12 }), h('span', { className: 'ab-muted' }, ' 条')),
      h(Row, { label: '清单和汇报整段发', hint: '开：带小标题、编号列表、代码块的内容整段发出，拆开会散。关：照样按上面的上限拆' }, f.sw('reply.keepReports')),
    ),
    h(OwnerBrief, { draft, setDraft }),
    h(Card, { title: '发文件', right: f.sw('files.enabled'), desc: '打开后，你在私聊里可以让她把本机文件当文件发到 QQ，也能按你说的发给白名单里的人或群。她只能发 QQ 工作区和下面目录里的文件；单个文件有大小上限；发过什么会记在日志里。' },
      h(Row, { label: '单个文件最大' }, f.num('files.maxMB', { min: 1, max: 2048 }), h('span', { className: 'ab-muted' }, ' MB')),
      h(Row, { label: '额外允许的目录', hint: '一行一个完整路径。QQ 工作区里的文件一直允许，不用写；留空 = 只能发工作区里的' }, f.list('files.dirs', { placeholder: 'D:\\Aurabot\\要发的文件' })),
    ),
            h(Card, { title: '危险命令确认', right: f.sw('security.dangerConfirm'), desc: '打开后，她在私聊里要执行终端危险命令（删根目录、格式化、关机、下载后直接执行等）之前，会先发 QQ 私聊问你；你回复「确认」才执行，回复「取消」或 60 秒没回就拦下。默认关。只拦真正致命的命令，普通删除/构建/改文件不受影响。' }),
h(Card, { title: '群里什么时候必回', desc: '被 @、有人引用回复她的消息、或者提到下面这些名字时，她一定会回。' },
      h(Row, { label: '唤醒词', hint: '一行一个' }, f.list('group.wakeWords', { placeholder: '大肥鱼\n肥鱼' })),
    ),
    h(Card, { title: '安全刹车', desc: '只防失控（比如和别的机器人聊停不下来）：她在一个群里短时间说太多就歇一会儿，主人 @ 她除外。平时碰不到。' },
      h(Row, { label: '最多说几次' }, f.range('group.burstMax', 1, 20, 1, (v) => v + ' 次'), h('span', { className: 'ab-muted' }, '/'), f.range('group.burstWindowSec', 30, 600, 30, (v) => Math.round(v / 6) / 10 + ' 分钟')),
    ),
    h(Card, { title: '群里插话', desc: '没人叫她的时候，她也可能自然地插一句；她看完群里在聊什么，也可以决定不说话。' },
      h(Row, { label: '插话概率', hint: '每条普通消息触发插话的机会' }, f.percent('group.interjectChance')),
      h(Row, { label: '冷却', hint: '两次插话至少隔多久' }, f.range('group.cooldownSec', 0, 600, 10, (v) => v + ' 秒')),
      h(Row, { label: '每小时最多插话' }, f.range('group.maxPerHour', 0, 30, 1, (v) => v + ' 次')),
      h(Row, { label: '她感兴趣的话题', hint: '群里在聊这些（或她记得相关的事）时更容易插话；一行一个' }, f.list('group.interests', { placeholder: '白米饭\n游戏\n追剧' })),
      h(Row, { label: '话题相关度门槛', hint: '和她关系不大的话题就不插话；拉到 0 = 不看话题、纯随机' }, f.range('group.minRelevance', 0, 1, 0.05, (v) => (v === 0 ? '不看话题' : Math.round(v * 100) + '%'))),
      h('div', { className: 'ab-note', style: { marginTop: 8 } }, '她被叫到或插上话以后算「加入了话题」：话题还和她相关、她 3 分钟内说过话，就会接着聊下去（每次看完群里新说的一段再回），不受冷却和每小时上限限制；话题跑偏或者她选择不说话就退出。'),
      h(Row, { label: '群冷清时不插话', hint: '最近几分钟内消息少于这个数就不插' }, f.num('group.minRecentMessages', { min: 0 }), h('span', { className: 'ab-muted' }, '条 / '), f.num('group.activeWindowSec', { min: 30 }), h('span', { className: 'ab-muted' }, '秒')),
      h(Row, { label: '静默时段', hint: '这段时间不插话（被叫到还是会回）' },
        h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[0], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [Number(e.target.value), draft.group.quietHours[1]])) }),
        h('span', { className: 'ab-muted' }, '点 到'),
        h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[1], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [draft.group.quietHours[0], Number(e.target.value)])) }),
        h('span', { className: 'ab-muted' }, '点')),
    ),
    h(Card, { title: '同类 bot 太多时不参与', desc: '防 bot 对聊刷屏，按「配对」掐（业界 bot-loop 做法）：她和一个对象互相针对地接话——已确认是鱼的 **2 个来回**就停、看不出来身份的 4 个来回才停，停的是这一对 30 分钟（它的 @ 也不接，别人和主人不受影响）；另有全局密度兜底（连续/占比）。名字看不出来的 bot（比如麦麦系的「某bot」）把号码加进下面的鱼名单，第二回合就掐。' },
      h(Row, { label: '启用', hint: '关掉就完全不判定，她照常按插话概率说话。' }, f.sw('group.fishGuard.enabled')),
      h(Row, { label: '按号码认同类 bot', hint: '逗号或空格隔开。名单里的人一律当成同类 bot（哪怕名字看不出）。' },
        // 输入过程保留原文（能敲逗号和空格），失焦才解析写回 —— 原来逐键 split+filter，
        // 敲到分隔符的那一刻内容就被吃掉了
        h(ListInput, { value: (Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.fishIds) ? draft.group.fishGuard.fishIds : []),
          placeholder: '例如 321321321, 456456456', numbers: true,
          onChange: (list) => setDraft((prev) => setPath(prev, 'group.fishGuard.fishIds', list)) })),
      h(Row, { label: '按名字认同类 bot', hint: '在默认的「肥鱼/鲸/fish」之外还要算哪些名字？逗号或空格隔开。名字带「鱼」但其实是真人的别加。' },
        h(ListInput, { value: (Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.nameSuffixes) ? draft.group.fishGuard.nameSuffixes : []),
          placeholder: '例如 小鱼, 咸鱼罐头',
          onChange: (list) => setDraft((prev) => setPath(prev, 'group.fishGuard.nameSuffixes', list)) })),
    ),
    h(Card, { title: '按群单独设置', desc: '某个群想让她更安静或更活跃，在这里单独设插话概率。' },
      Object.keys(overrides).length === 0 ? h('div', { className: 'ab-muted', style: { marginBottom: 10 } }, '还没有单独设置的群。') :
        Object.entries(overrides).map(([gid, o]) => h(PercentRow, { key: gid, label: '群 ' + gid,
          value: o.interjectChance, fallback: draft.group.interjectChance,
          // 三个写回点全部用函数式 setDraft：旧快照会把刚删的群又写回来（与 persona 分流表同款 bug）
          write: (v) => setDraft((prev) => { const cur = (prev.group.overrides || {})[gid] || {}; return setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [gid]: { ...cur, interjectChance: v } }) }),
          remove: () => setDraft((prev) => { const n = { ...(prev.group.overrides || {}) }; delete n[gid]; return setPath(prev, 'group.overrides', n) }) })),
      h('div', { className: 'ab-flex' }, h('input', { className: 'ab-input', placeholder: '群号', value: newGid, onChange: (e) => setNewGid(e.target.value.replace(/\D/g, '')) }),
        h(Btn, { small: true, disabled: !newGid, onClick: () => { setDraft((prev) => setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [newGid]: { interjectChance: prev.group.interjectChance } })); setNewGid('') } }, '添加')),
    ),
  )
}

/** 按聊天选模型：私聊默认 / 群聊默认两个下拉，单个 QQ / 群的例外放在默认收起的小列表里。 */

export { Group }
