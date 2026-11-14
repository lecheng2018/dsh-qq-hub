import { useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Choices } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, cx } from '../core/utils.js'
import { get } from '../core/http.js'

function Access({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  return (
    <div className="ab-grid">
      <Card title="主人" desc="主人的 QQ 号。群管、电脑上的操作只听主人的。">
        <Row label="主人 QQ 号">{f.text('ownerQQ')}</Row>
        <Row label="她怎么称呼你">{f.text('ownerName', { placeholder: '主人' })}</Row>
        <Row label="主人私聊的权限" hint="群聊永远没有电脑操作权限，这里管不到群。">
          <div style={{ width: '100%' }}>
            <Choices
              value={draft.ownerLevel}
              onChange={(v) => setDraft(setPath(draft, 'ownerLevel', v))}
              options={[
                { value: 'full', label: '完整', desc: '私聊里让她用电脑做事（查文件、跑命令、上网查）也能做' },
                { value: 'social', label: '受限', desc: '只有发表情、发说说这类 QQ 工具，碰不到电脑' },
                { value: 'chat', label: '纯聊天', desc: '什么工具都没有，只聊天' },
              ]}
            />
            <div className="ab-muted ab-small" style={{ marginTop: 8 }}>切换后会给主人私聊换一个新的 DSH 会话（旧的还在侧栏里）。</div>
          </div>
        </Row>
        <Row label="长任务模式" hint="只在「完整」权限下生效。打开后她能把命令放到后台跑、跑完自动回来告诉你，也能设定时任务；工具多一点，回话会稍慢。切换后同样换新会话。">
          <Choices
            value={draft.longTasks ? 'on' : 'off'}
            onChange={(v) => setDraft(setPath(draft, 'longTasks', v === 'on'))}
            options={[
              { value: 'off', label: '关', desc: '维持现在的速度（默认）' },
              { value: 'on', label: '开', desc: '挂上后台任务（jobs）+ 定时任务（schedule）' },
            ]}
          />
        </Row>
      </Card>
      <ProfilePerms draft={draft} setDraft={setDraft} />
      <Card title="白名单" desc="只有名单里的人和群，她才会理。一行一个号码。">
        <Row label="私聊白名单" hint="主人默认就在里面。">{f.list('allow.private', { placeholder: '每行一个 QQ 号', numbers: true })}</Row>
        <Row label="群白名单" hint="把机器人拉进群后，把群号加到这里。">{f.list('allow.groups', { placeholder: '每行一个群号', numbers: true })}</Row>
      </Card>
      <GroupRoles />
      <CommandList />
    </div>
  )
}

const PERM_OPTS = [
  { value: 'off', label: '关', desc: '谁说都不改' },
  { value: 'owner', label: '仅主人私聊', desc: '只有你私聊让她改才改（默认）' },
  { value: 'all', label: '所有人', desc: '白名单里的人、群里的人都能让她改' },
]

/** 改资料类操作的权限：关 / 仅主人私聊 / 所有人。 */
function ProfilePerms({ draft, setDraft }) {
  const perms = draft.profilePerms || {}
  const row = (key, label, hint) => (
    <Row key={key} label={label} hint={hint}>
      <Choices value={perms[key] || 'owner'} onChange={(v) => setDraft(setPath(draft, 'profilePerms.' + key, v))} options={PERM_OPTS} />
    </Row>
  )
  return (
    <Card
      collapse
      title="改资料与名单"
      desc="她能不能按别人的要求改自己的昵称、签名、头像，处理好友申请、改白名单，以及在抖音 / 小黑盒上的浏览、点赞、评论。默认都只听主人的，要放开在这里逐项开。"
      more={'说明：\n· QQ 昵称 / 签名 / 头像要 SnowLuma 支持（set_qq_profile / set_self_longnick / set_qq_avatar）。\n· B 站签名 / 头像要先在「B站」页登录。\n· 好友申请：她自己主动加别人暂不支持（SnowLuma 没有这个接口）。\n· 抖音 / 小黑盒的定时自动刷不受「浏览」这项限制；「分享抖音给主人」指刷到好玩的私聊发给你。'}
    >
      {row('qqNickname', 'QQ 昵称')}
      {row('qqSignature', 'QQ 个性签名')}
      {row('qqAvatar', 'QQ 头像', '只用网址图片，或「刚才发的那张图」。')}
      {row('biliSign', 'B 站签名', '要先在 B 站页登录并打开 B 站。')}
      {row('biliAvatar', 'B 站头像', '要先在 B 站页登录并打开 B 站。图片网址或刚才发的图，最大 2MB。')}
      {row('qqFriendRequest', '处理好友申请', '让她通过 / 拒绝别人加她为好友的申请。')}
      {row('whitelist', '改白名单', '让她把 QQ 号 / 群号加进或移出白名单。主人不会被移出。开成「所有人」前请想清楚。')}
      {row('douyinBrowse', '刷抖音 / 看视频', '让她去刷推荐、点开别人发来的抖音链接。')}
      {row('douyinLike', '抖音点赞', '有人让她给某个视频点赞；关掉后她自己刷的时候也不点赞。')}
      {row('douyinComment', '抖音评论', '有人让她去某个视频下评论；关掉后她自己刷的时候也不评论。')}
      {row('douyinShareOwner', '分享抖音给主人', '刷到好玩的视频在 QQ 私聊里发给你（她的话 + 链接）。')}
      {row('douyinDm', '主动发抖音私信', '主人明确让她给某个人发私信时（主页链接或抖音号）。默认仅主人私聊。')}
      {row('heyboxBrowse', '逛小黑盒 / 看帖子', '让她翻信息流、读帖子正文和热评、看热榜和搜帖子。')}
      {row('heyboxLike', '小黑盒点赞', '有人让她给某个帖子点赞；关掉后她自己逛的时候也不点赞。')}
      {row('heyboxComment', '小黑盒评论', '有人让她去某个帖子下评论；关掉后她自己逛的时候也不评论。')}
      {row('heyboxPost', '小黑盒发帖 / 删帖', '让她发帖（文章模式可带图）和删自己发的帖。发帖会用你的账号公开发布，默认仅主人私聊。')}
    </Card>
  )
}

/** QQ 里的主人命令一览。 */
function CommandList() {
  const [list, setList] = useState([])
  useEffect(() => { get('/commands').then((r) => setList(r.list || [])) }, [])
  return (
    <Card title="QQ 命令" desc="主人在 QQ 里（私聊或白名单群）直接发这些命令就能管她，别人发了不算。总开关关着时也能用。">
      <table className="ab-table">
        <tbody>
          {list.map((c) => (
            <tr key={c.name}>
              <td style={{ whiteSpace: 'nowrap' }}>
                <code>/{c.name}</code>
                {c.aliases.length ? <div className="ab-muted ab-small">{c.aliases.map((a) => '/' + a).join(' ')}</div> : null}
              </td>
              <td>{c.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/** 她在每个白名单群里的身份：群主 / 管理员才能禁言踢人。 */
function GroupRoles() {
  const [list, setList] = useState(null)
  const load = () => { setList(null); get('/groups/roles').then((r) => setList(r.list || [])) }
  useEffect(load, [])
  return (
    <Card title="群管权限" desc="她在群里是群主或管理员时，主人才能让她禁言、踢人、发公告；改专属头衔要群主。按已保存的群白名单查。" right={<Btn small kind="ghost" onClick={load}>刷新</Btn>}>
      {!list
        ? <div className="ab-muted ab-small"><i className="ab-spin" /> 查询中…</div>
        : list.length === 0 ? <div className="ab-muted ab-small">群白名单是空的。</div>
          : (
            <table className="ab-table">
              <thead><tr>{['群', '她的身份', '群管'].map((x) => <th key={x}>{x}</th>)}</tr></thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.groupId}>
                    <td>{(g.name && g.name !== g.groupId ? g.name + ' ' : '') + '(' + g.groupId + ')'}</td>
                    <td>{g.label}</td>
                    <td>{g.canManage ? <span className="ab-badge">可以</span> : <span className="ab-muted ab-small">不行</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </Card>
  )
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
  return (
    <Card
      title="主人私聊：群聊摘要" right={f.sw('group.ownerBrief.enabled')}
      desc="主人在私聊里问起群里的事时，把最近 24 小时的群聊流水当成「她自己的见闻」补进这一轮上下文。只在主人私聊提到群相关的事时触发，不常驻、不写进记忆；默认关。"
      more={'开启前先在「权限」页把群加进白名单。她只会当成自己最近在群里看到的，不会把群聊原文说成是主人发的。'}
    >
      <Row label="每个群给几条" hint="越少越省上下文；最多 30 条">{f.range('group.ownerBrief.lines', 1, 30, 1, (v) => v + ' 条')}</Row>
      <Row label="只取哪些群" hint="没勾 = 所有白名单群；只列白名单里的群">
        {groups.length
          ? <div className="ab-flex">{groups.map((gid) => <button key={gid} type="button" className={cx('ab-chip', on(gid) && 'on')} onClick={() => toggle(gid)}>{(on(gid) ? '✓ ' : '') + (nameOf(gid) || '群')}<span className="n">{gid}</span></button>)}</div>
          : <span className="ab-muted ab-small">群白名单是空的，先在「权限」页加群。</span>}
      </Row>
    </Card>
  )
}

export { Access, ProfilePerms, CommandList, GroupRoles, OwnerBrief }
