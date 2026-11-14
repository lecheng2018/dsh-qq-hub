import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, ListInput, Choices, SectionNav, HelpDisclosure, DataTable } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, cx } from '../core/utils.js'
import { get } from '../core/http.js'

function Access({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  return h('div', { className: 'ab-grid' },
    h(SectionNav, { items: [{ id: 'access-owner', label: '主人能力' }, { id: 'access-profile', label: '操作权限' }, { id: 'access-allow', label: '访问名单' }, { id: 'access-reference', label: '群管与命令' }] }),
    h(Card, { id: 'access-owner', title: '主人与长任务', summary: '设置主人身份、私聊工具权限和后台任务能力。' },
      h(Row, { label: '主人 QQ 号' }, f.text('ownerQQ')),
      h(Row, { label: '她怎么称呼你' }, f.text('ownerName', { placeholder: '主人' })),
      h(Row, { label: '主人私聊的权限', hint: '群聊永远没有电脑操作权限。' },
        h('div', { style: { width: '100%' } },
          h(Choices, { compact: true, value: draft.ownerLevel, onChange: (v) => setDraft(setPath(draft, 'ownerLevel', v)), options: [
            { value: 'full', label: '完整', desc: '允许查文件、跑命令、上网查等电脑操作。' },
            { value: 'social', label: '受限', desc: '仅 QQ 工具，不接触电脑。' },
            { value: 'chat', label: '纯聊天', desc: '禁用工具，只聊天。' },
          ] }),
          h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '切换后主人私聊使用新的 DSH 会话，旧会话仍保留。'))),
      h(Row, { label: '长任务模式', hint: '仅完整权限生效；切换后使用新会话' },
        h(Choices, { compact: true, value: draft.longTasks ? 'on' : 'off', onChange: (v) => setDraft(setPath(draft, 'longTasks', v === 'on')), options: [
          { value: 'off', label: '关', desc: '保持较少工具和更快回复。' },
          { value: 'on', label: '开', desc: '启用后台任务与定时任务，工具更多，回复可能稍慢。' },
        ] })),
    ),
    h(ProfilePerms, { draft, setDraft }),
    h(Card, { id: 'access-allow', title: '白名单', summary: '仅名单内的人和群可以触发回复；主人始终可私聊。' },
      h(Row, { label: '私聊白名单', hint: '一行一个 QQ 号' }, f.list('allow.private', { placeholder: '每行一个 QQ 号', numbers: true })),
      h(Row, { label: '群白名单', hint: '一行一个群号' }, f.list('allow.groups', { placeholder: '每行一个群号', numbers: true })),
    ),
    h('section', { id: 'access-reference', className: 'ab-grid' }, h(GroupRoles, null), h(CommandList, null)),
  )
}

/** 改资料类操作的权限：关 / 仅主人私聊 / 所有人。 */
function ProfilePerms({ draft, setDraft }) {
  const perms = draft.profilePerms || {}
  const opts = [
    { value: 'off', label: '关', desc: '谁说都不改' },
    { value: 'owner', label: '仅主人私聊', desc: '只有你私聊让她改才改（默认）' },
    { value: 'all', label: '所有人', desc: '白名单里的人、群里的人都能让她改' },
  ]
  const row = (key, label, hint) => h(Row, { label, hint, layout: 'stacked' },
    h(Choices, { compact: true, value: perms[key] || 'owner', onChange: (v) => setDraft(setPath(draft, 'profilePerms.' + key, v)), options: opts }))
  return h(Card, { id: 'access-profile', title: '资料与平台操作权限', summary: '每项都可设为关闭、仅主人私聊或对白名单内所有人开放。' },
    h('div', { className: 'ab-note warn' }, '「所有人」仍受白名单限制。公开发帖、改白名单和主动私信属于高风险权限，请谨慎开放。'),
    row('qqNickname', 'QQ 昵称'),
    row('qqSignature', 'QQ 个性签名'),
    row('qqAvatar', 'QQ 头像', '只用网址图片，或「刚才发的那张图」。'),
    row('biliSign', 'B 站签名', '要先在 B 站页登录并打开 B 站。'),
    row('biliAvatar', 'B 站头像', '要先在 B 站页登录并打开 B 站。图片网址或刚才发的图，最大 2MB。'),
    row('qqFriendRequest', '处理好友申请', '让她通过 / 拒绝别人加她为好友的申请。她自己主动加别人暂不支持（SnowLuma 没有这个接口）。'),
    row('whitelist', '改白名单', '让她把 QQ 号 / 群号加进或移出下面的白名单。主人不会被移出。开成「所有人」前请想清楚。'),
    row('douyinBrowse', '刷抖音 / 看视频', '让她去刷推荐（douyin_browse）、点开别人发来的抖音链接（douyin_watch）。定时自己刷不受这项限制。'),
    row('douyinLike', '抖音点赞', '有人让她给某个视频点赞；关掉后她自己刷的时候也不点赞。'),
    row('douyinComment', '抖音评论', '有人让她去某个视频下评论；关掉后她自己刷的时候也不评论。'),
    row('douyinShareOwner', '分享抖音给主人', '刷到好玩的视频在 QQ 私聊里发给你（她的话 + 链接）。'),
    row('douyinDm', '主动发抖音私信', '主人明确让她给某个人发私信时（主页链接或抖音号）；列表里没有会话会从对方主页发起。默认仅主人私聊。'),
    row('heyboxBrowse', '逛小黑盒 / 看帖子', '让她翻信息流（heybox_feed）、读帖子正文和热评（heybox_watch）、看热榜和搜帖子（heybox_hot / heybox_search / heybox_topics）。定时自己逛不受这项限制。'),
    row('heyboxLike', '小黑盒点赞', '有人让她给某个帖子点赞；关掉后她自己逛的时候也不点赞。'),
    row('heyboxComment', '小黑盒评论', '有人让她去某个帖子下评论；关掉后她自己逛的时候也不评论。'),
    row('heyboxPost', '小黑盒发帖 / 删帖', '让她发帖（heybox_post，文章模式可带图）和删自己发的帖（heybox_delete）。发帖会用你的账号公开发布，默认仅主人私聊。'),
  )
}

/** QQ 里的主人命令一览。 */
function CommandList() {
  const [list, setList] = useState([])
  useEffect(() => { get('/commands').then((r) => setList(r.list || [])) }, [])
  return h(Card, { title: 'QQ 命令', summary: '主人在私聊或白名单群中可直接使用；总开关关闭时仍可用。', collapsible: true, defaultOpen: false },
    h(DataTable, { columns: [
      { key: 'command', label: '命令', render: (c) => h(Fragment, null, h('code', null, '/' + c.name), c.aliases.length ? h('div', { className: 'ab-muted ab-small' }, c.aliases.map((a) => '/' + a).join(' ')) : null) },
      { key: 'desc', label: '作用', render: (c) => c.desc },
    ], rows: list, rowKey: (c) => c.name }))
}

/** 她在每个白名单群里的身份：群主 / 管理员才能禁言踢人。 */
function GroupRoles() {
  const [list, setList] = useState(null)
  const load = () => { setList(null); get('/groups/roles').then((r) => setList(r.list || [])) }
  useEffect(load, [])
  return h(Card, { title: '群管权限', summary: '群主或管理员身份决定禁言、踢人和公告能力；改专属头衔需群主。', collapsible: true, defaultOpen: false,
    right: h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新') },
    !list ? h('div', { className: 'ab-muted ab-small' }, h('i', { className: 'ab-spin' }), ' 查询中…')
      : list.length === 0 ? h('div', { className: 'ab-muted ab-small' }, '群白名单是空的。')
      : h('table', { className: 'ab-table' },
        h('thead', null, h('tr', null, ['群', '她的身份', '群管'].map((x) => h('th', { key: x }, x)))),
        h('tbody', null, list.map((g) => h('tr', { key: g.groupId },
          h('td', null, (g.name && g.name !== g.groupId ? g.name + ' ' : '') + '(' + g.groupId + ')'),
          h('td', null, g.label),
          h('td', null, g.canManage ? h('span', { className: 'ab-badge' }, '可以') : h('span', { className: 'ab-muted ab-small' }, '不行')))))))
}

function OwnerBrief({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  const ob = draft.group.ownerBrief || { enabled: false, lines: 12, groups: [] }
  const groups = (draft.allow.groups || []).map(String)
  const [info, setInfo] = useState(null)
  useEffect(() => { get('/groups/titles').then((r) => { if (r.ok) setInfo(r) }).catch(() => {}) }, [])
  const nameOf = (gid) => {
    const g = ((info && info.groups) || []).find((x) => x.groupId === gid)
    return g && g.name && g.name !== gid ? g.name : ''
  }
  const on = (gid) => (ob.groups || []).includes(gid)
  const toggle = (gid) => setDraft(setPath(draft, 'group.ownerBrief.groups', on(gid) ? (ob.groups || []).filter((x) => x !== gid) : [...(ob.groups || []), gid]))
  return h(Card, { title: '主人私聊：群聊摘要', right: f.sw('group.ownerBrief.enabled'),
    summary: '主人私聊问起群聊时，补充最近 24 小时的相关流水。', collapsible: true, defaultOpen: false },
    h(Row, { label: '每个群给几条', hint: '越少越省上下文；最多 30 条' }, f.range('group.ownerBrief.lines', 1, 30, 1, (v) => v + ' 条')),
    h(Row, { label: '只取哪些群', hint: '没勾 = 所有白名单群；只列白名单里的群' },
      groups.length
        ? h('div', { className: 'ab-flex' }, groups.map((gid) => h('button', { key: gid, type: 'button', className: cx('ab-chip', on(gid) && 'on'), onClick: () => toggle(gid) },
          (on(gid) ? '✓ ' : '') + (nameOf(gid) || '群'), h('span', { className: 'n' }, gid))))
        : h('span', { className: 'ab-muted ab-small' }, '群白名单是空的，先在「权限」页加群。')),
    h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } }, '她只会当成自己最近在群里看到的，不会把群聊原文说成是主人发的。'))
}


export { Access, ProfilePerms, CommandList, GroupRoles, OwnerBrief }
