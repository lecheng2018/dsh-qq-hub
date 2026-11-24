import { useState, useEffect, h } from '../core/react.js'
import { Card, Row, Btn, Choices, Seg, Pill } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, cx } from '../core/utils.js'
import { get } from '../core/http.js'

const LEVEL_TEXT = { full: '完整权限', social: '受限（只有 QQ 工具）', chat: '纯聊天' }

function Access({ draft, setDraft }) {
  const privates = (draft.allow && draft.allow.private) || []
  const groups = (draft.allow && draft.allow.groups) || []
  const perms = draft.profilePerms || {}
  const loosened = Object.values(perms).filter((v) => v && v !== 'owner').length
  return (
    <div className="ab-grid">
      <Card
        title="现在她是谁、能碰什么"
        desc="一眼看清：主人是谁、给到什么档位、白名单里有谁、改资料类放开了几项。要改去下面对应的卡。"
      >
        <div className="ab-pills">
          <Pill title="主人 QQ 号">主人 {draft.ownerQQ || '没设'}</Pill>
          <Pill kind={draft.ownerLevel === 'full' ? 'warn' : undefined}>{LEVEL_TEXT[draft.ownerLevel] || '完整权限'}</Pill>
          <Pill title="只有名单里的人和群她才会理">白名单 私聊 {privates.length} / 群 {groups.length}</Pill>
          <Pill kind={loosened ? 'warn' : undefined} title="改资料类操作里被放开到「所有人」或显式开启的项数">改资料放开 {loosened} 项</Pill>
          {draft.longTasks ? <Pill kind="warn">长任务模式 开</Pill> : null}
        </div>
      </Card>
      <OwnerCard draft={draft} setDraft={setDraft} />
      <OwnerPower draft={draft} setDraft={setDraft} />
      <Whitelist draft={draft} setDraft={setDraft} />
      <ProfilePerms draft={draft} setDraft={setDraft} />
      <div className="ab-grid ab-g2">
        <GroupRoles />
        <CommandList />
      </div>
    </div>
  )
}

/** 主人身份：QQ 号与称呼（最常改的两项）。 */
function OwnerCard({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  return (
    <Card title="主人" desc="主人的 QQ 号。群管、电脑上的操作只听主人的。">
      <Row label="主人 QQ 号">{f.text('ownerQQ')}</Row>
      <Row label="她怎么称呼你">{f.text('ownerName', { placeholder: '主人' })}</Row>
    </Card>
  )
}

/** 白名单：高频（新群要加），保持常开。 */
function Whitelist({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  return (
    <Card title="白名单" desc="只有名单里的人和群，她才会理。一行一个号码。">
      <Row label="私聊白名单" hint="主人默认就在里面。">{f.list('allow.private', { placeholder: '每行一个 QQ 号', numbers: true })}</Row>
      <Row label="群白名单" hint="把机器人拉进群后，把群号加到这里。">{f.list('allow.groups', { placeholder: '每行一个群号', numbers: true })}</Row>
    </Card>
  )
}

/** 权限档位与长任务：核心权限配置。 */
function OwnerPower({ draft, setDraft }) {
  return (
    <Card
      title="她能做到哪一步"
      desc="主人私聊的权限档位（能不能用电脑上的工具）和长任务模式。默认「完整」；不需要她碰电脑时，降到「受限」或「纯聊天」更安全。"
      more={'群聊永远没有电脑操作权限，这里管不到群。\n切换档位会给主人私聊换一个新的 DSH 会话（旧的还在侧栏里）。\n长任务模式只在「完整」下生效：打开后她能把命令放后台跑、跑完回来告诉你，也能设定时任务；工具多一点，回话会稍慢。'}
    >
      <Row label="主人私聊的权限">
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
        </div>
      </Row>
      <Row label="长任务模式" hint="只在「完整」权限下生效。">
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
  )
}

const PERM_OPTS = [
  { value: 'off', label: '关', desc: '谁说都不改' },
  { value: 'owner', label: '仅主人私聊', desc: '只有你私聊让她改才改（默认）' },
  { value: 'all', label: '所有人', desc: '白名单里的人、群里的人都能让她改' },
]

/** 分组：17 项权限按平台分页，展开也不至于一堵墙。 */
const PERM_GROUPS = [
  { id: 'qq', label: 'QQ', keys: ['qqNickname', 'qqSignature', 'qqAvatar'] },
  { id: 'social', label: '好友', keys: ['qqFriendRequest', 'whitelist'] },
  { id: 'bili', label: 'B站', keys: ['biliSign', 'biliAvatar'] },
  { id: 'douyin', label: '抖音', keys: ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm'] },
  { id: 'heybox', label: '小黑盒', keys: ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost'] },
]
const PERM_ITEMS = {
  qqNickname: ['QQ 昵称', ''],
  qqSignature: ['QQ 个性签名', ''],
  qqAvatar: ['QQ 头像', '只用网址图片，或「刚才发的那张图」。'],
  qqFriendRequest: ['处理好友申请', '让她通过 / 拒绝别人加她为好友的申请。'],
  whitelist: ['改白名单', '让她把 QQ 号 / 群号加进或移出白名单。主人不会被移出。开成「所有人」前请想清楚。'],
  biliSign: ['B 站签名', '要先在 B 站页登录并打开 B 站。'],
  biliAvatar: ['B 站头像', '要先在 B 站页登录并打开 B 站。图片网址或刚才发的图，最大 2MB。'],
  douyinBrowse: ['刷抖音 / 看视频', '让她去刷推荐、点开别人发来的抖音链接。'],
  douyinLike: ['抖音点赞', '有人让她给某个视频点赞；关掉后她自己刷的时候也不点赞。'],
  douyinComment: ['抖音评论', '有人让她去某个视频下评论；关掉后她自己刷的时候也不评论。'],
  douyinShareOwner: ['分享抖音给主人', '刷到好玩的视频在 QQ 私聊里发给你（她的话 + 链接）。'],
  douyinDm: ['主动发抖音私信', '主人明确让她给某个人发私信时（主页链接或抖音号）。默认仅主人私聊。'],
  heyboxBrowse: ['逛小黑盒 / 看帖子', '让她翻信息流、读帖子正文和热评、看热榜和搜帖子。'],
  heyboxLike: ['小黑盒点赞', '有人让她给某个帖子点赞；关掉后她自己逛的时候也不点赞。'],
  heyboxComment: ['小黑盒评论', '有人让她去某个帖子下评论；关掉后她自己逛的时候也不评论。'],
  heyboxPost: ['小黑盒发帖 / 删帖', '让她发帖（文章模式可带图）和删自己发的帖。发帖会用你的账号公开发布，默认仅主人私聊。'],
}

/** 改资料类操作的权限：关 / 仅主人私聊 / 所有人。按平台分页。 */
function ProfilePerms({ draft, setDraft }) {
  const perms = draft.profilePerms || {}
  const [group, setGroup] = useState('qq')
  const cur = PERM_GROUPS.find((g) => g.id === group) || PERM_GROUPS[0]
  const loosened = (keys) => keys.filter((k) => perms[k] && perms[k] !== 'owner').length
  return (
    <Card
      title="改资料与名单"
      desc="她能不能按别人的要求改自己的昵称、签名、头像，处理好友申请、改白名单，以及在抖音 / 小黑盒上的浏览、点赞、评论。默认都只听主人的，要放开在这里逐项开。"
      more={'说明：\n· QQ 昵称 / 签名 / 头像要 SnowLuma 支持（set_qq_profile / set_self_longnick / set_qq_avatar）。\n· B 站签名 / 头像要先在「B站」页登录。\n· 好友申请：她自己主动加别人暂不支持（SnowLuma 没有这个接口）。\n· 抖音 / 小黑盒的定时自动刷不受「浏览」这项限制；「分享抖音给主人」指刷到好玩的私聊发给你。'}
    >
      <Seg value={group} onChange={setGroup} options={PERM_GROUPS.map((g) => ({ value: g.id, label: g.label }))} />
      <div className="ab-small ab-muted" style={{ marginTop: 8 }}>
        这一组（{cur.label}）共 {cur.keys.length} 项 · 放开 {loosened(cur.keys)} 项（没放开的都是「仅主人私聊」）
      </div>
      <div style={{ marginTop: 10 }}>
        {cur.keys.map((k) => (
          <Row key={k} label={PERM_ITEMS[k][0]} hint={PERM_ITEMS[k][1]}>
            <Choices value={perms[k] || 'owner'} onChange={(v) => setDraft(setPath(draft, 'profilePerms.' + k, v))} options={PERM_OPTS} />
          </Row>
        ))}
      </div>
    </Card>
  )
}

/** QQ 里的主人命令一览（参考）。 */
function CommandList() {
  const [list, setList] = useState([])
  useEffect(() => { get('/commands').then((r) => setList(r.list || [])) }, [])
  return (
    <Card title={'QQ 命令（' + list.length + ' 条）'} desc="主人在 QQ 里（私聊或白名单群）发这些命令就能管她。总开关关着时也能用。">
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
  // 群名统一走 /panel/chats（审计 Q13）：/groups/titles 随 title-filter 一起下线了，
  // 旧代码的失败被 catch 静默吞掉，群名永远退回群号，功能坏了也没人发现。
  useEffect(() => { get('/panel/chats').then((r) => { if (r && r.ok) setInfo(r) }).catch(() => {}) }, [])
  const nameOf = (gid) => {
    const c = ((info && info.chats) || []).find((x) => x.kind === 'group' && String(x.id) === String(gid))
    return (c && c.rawName) || '' // rawName 是不带「QQ 群 · 」前缀的纯群名；没聊过天的群拿不到，退回群号
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
          ? <div className="ab-flex" style={{ flexWrap: 'wrap' }}>{groups.map((gid) => <button key={gid} type="button" className={cx('ab-chip', on(gid) && 'on')} onClick={() => toggle(gid)}>{(on(gid) ? '✓ ' : '') + (nameOf(gid) || '群')}<span className="n">{gid}</span></button>)}</div>
          : <span className="ab-muted ab-small">群白名单是空的，先在「权限」页加群。</span>}
      </Row>
    </Card>
  )
}

export { Access, ProfilePerms, CommandList, GroupRoles, OwnerBrief, OwnerPower, OwnerCard, Whitelist }
