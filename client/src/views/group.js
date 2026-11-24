import { useState, Fragment, h } from '../core/react.js'
import { Card, FoldSection, Row, Btn, ListInput, PercentRow, More } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath } from '../core/utils.js'
import { OwnerBrief } from './access.js'

function Group({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  const overrides = draft.group.overrides || {}
  const [newGid, setNewGid] = useState('')

  return (
    <div className="ab-grid">
      <Card
        title="消息节奏"
        desc="人常常一口气发好几句：她等对方说完再一起回，而不是一句一回；遇到复杂任务也能安心等待。"
      >
        <Row label="连发合并" hint="打开后她会等对方说完再回">{f.sw('merge.enabled')}</Row>
        <Row label="对方停顿多久算说完">{f.range('merge.waitSec', 0.5, 10, 0.5, (v) => v + ' 秒')}</Row>
        <Row label="最多等多久" hint="对方一直在发也最多等这么久">{f.range('merge.maxSec', 2, 30, 1, (v) => v + ' 秒')}</Row>

        <FoldSection title="高级微调（群等待与超时）" desc="微调群内多人群聊节奏以及模型长任务中断阈值">
          <Row label="群里停顿多久算一段" hint="群里你一句我一句，多等一会儿把一段话攒齐再回；她回上一段的时候，新消息也会先攒着">{f.range('merge.groupWaitSec', 1, 20, 1, (v) => v + ' 秒')}</Row>
          <Row label="群里最多等多久">{f.range('merge.groupMaxSec', 3, 60, 1, (v) => v + ' 秒')}</Row>
          <Row label="回合超时" hint="模型或工具长时间不结束时停止等待并提示你；超时的旧回复不会补发，你发下一条时新建会话。可设 1～120 分钟">
            <input
              className="ab-input sm" type="number" min={1} max={120} step={1}
              value={Math.round((Number(draft.turnTimeoutMs) || 600000) / 60000)}
              onChange={(e) => setDraft(setPath(draft, 'turnTimeoutMs', Number(e.target.value) * 60000))}
            />
            <span className="ab-muted">分钟</span>
          </Row>
        </FoldSection>
      </Card>

      <Card
        title="怎么说话（分条）"
        desc="她写的 ||| 一定断开；空行算段落；句末标点会按字数上限攒成条。句子太短不会单独成条，攒够一截才断。"
        more={'换行不代表换消息：一行一个要点的排版会攒成一条发；她真的一行一句话（每行都很短）时，换行就是分条。\n清单和汇报（带小标题、编号列表、代码块）整段发出，拆开会散——用下面的开关控制。'}
      >
        <Row label="群里一条最长" hint="攒到这么长就断开；正常聊天她一般写得比这短">{f.num('reply.groupMaxChars', { min: 10, max: 500 })}<span className="ab-muted">字</span></Row>
        <Row label="私聊一条最长" hint="私聊可以整段说，设大一点更像正常聊天">{f.num('reply.privateMaxChars', { min: 20, max: 2000 })}<span className="ab-muted">字</span></Row>
        <Row label="一轮最多几条" hint="超过就均匀合并，不会把剩下的全塞进最后一条">{f.num('reply.maxBubbles', { min: 1, max: 12 })}<span className="ab-muted">条</span></Row>
        <Row label="清单和汇报整段发" hint="开：带小标题、编号列表、代码块的内容整段发出，拆开会散。关：照样按上面的上限拆">{f.sw('reply.keepReports')}</Row>
      </Card>

      <Card
        title="群聊互动机制"
        desc="群里被 @、引用或提到名字时必回；没人叫她时按概率自然插话。"
      >
        <div className="ab-section-title" style={{ marginTop: 4 }}>被叫到一定回</div>
        <Row label="唤醒词" hint="一行一个；被 @、有人引用回复她的消息、或提到这些名字时，她一定会回。">{f.list('group.wakeWords', { placeholder: '大肥鱼\n肥鱼' })}</Row>

        <div className="ab-section-title">主动插话</div>
        <Row label="插话概率" hint="每条普通消息触发插话的机会">{f.percent('group.interjectChance')}</Row>
        <Row label="冷却" hint="两次插话至少隔多久">{f.range('group.cooldownSec', 0, 600, 10, (v) => v + ' 秒')}</Row>
        <Row label="每小时最多说" hint="这是说话总条数（插话和接着聊都算），不是只看插话次数；额度按小时均摊发放，允许最多三分之一连发">{f.range('group.maxPerHour', 0, 120, 1, (v) => v + ' 条')}</Row>
        <Row label="她感兴趣的话题" hint="群里在聊这些（或她记得相关的事）时更容易插话；一行一个">{f.list('group.interests', { placeholder: '白米饭\n游戏\n追剧' })}</Row>
        <Row label="话题相关度门槛" hint="和她关系不大的话题就不插话；拉到 0 = 不看话题、纯随机">{f.range('group.minRelevance', 0, 1, 0.05, (v) => (v === 0 ? '不看话题' : v + ' 以上'))}</Row>

        <div className="ab-section-title">群事件通知与辅助功能</div>
        <Row label="进群打招呼" hint="有人进群或自己被拉进群时在群里说一句，开群多的别开">{f.sw('group.welcome.enabled')}</Row>
        <Row label="戳一戳回复" hint="群里有人双击头像戳她时回一句">{f.sw('group.poke.enabled')}</Row>
        {draft.group && draft.group.poke && draft.group.poke.enabled ? (
          <Fragment>
            <Row label="戳一戳回复内容">{f.text('group.poke.reply', { placeholder: '干嘛呀' })}</Row>
            <Row label="戳一戳冷却">{f.range('group.poke.cooldownSec', 0, 300, 5, (v) => v + ' 秒')}</Row>
          </Fragment>
        ) : null}
        <Row label="被移出群私聊通知" hint="被踢或被退群时，在控制台和主人私聊里留一条记录">{f.sw('group.leaveNotice')}</Row>
        <Row label="回复失败群内提醒" hint="报错或网络断开没回出来时在群里说一声，关则默默吞掉">{f.sw('group.failNotice')}</Row>
        <Row label="被禁言自动暂停" hint="被群管理员禁言时暂停往这个群发消息直到解禁">{f.sw('group.muteDetect')}</Row>

        <FoldSection title="防两只 Bot 互相刷屏（高级选项）" desc="群里还有另一只用类似人设的 bot 时防死循环互刷" defaultOpen={false}>
          <Row label="启用防御" hint="群里还有另一只用类似人设的 bot 时，避免接对方的话停不下来">{f.sw('group.fishGuard.enabled')}</Row>
          {draft.group && draft.group.fishGuard && draft.group.fishGuard.enabled ? (
            <Fragment>
              <Row label="按 QQ 号认同类 bot" hint="逗号或空格隔开。写在这里的号说的话她一律不接">
                <ListInput
                  value={Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.fishIds) ? draft.group.fishGuard.fishIds : []}
                  placeholder="例如 123456789, 987654321" numbers
                  onChange={(list) => setDraft((prev) => setPath(prev, 'group.fishGuard.fishIds', list))}
                />
              </Row>
              <Row label="按名字认同类 bot" hint="在默认的「肥鱼/鲸/fish」之外还要算哪些名字？逗号或空格隔开。名字带「鱼」但其实是真人的别加。">
                <ListInput
                  value={Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.nameSuffixes) ? draft.group.fishGuard.nameSuffixes : []}
                  placeholder="例如 小鱼, 咸鱼罐头"
                  onChange={(list) => setDraft((prev) => setPath(prev, 'group.fishGuard.nameSuffixes', list))}
                />
              </Row>
            </Fragment>
          ) : null}
        </FoldSection>
      </Card>

      <Card
        collapse={Object.keys(overrides).length === 0}
        title="按群单独设置插话概率"
        desc="某个群想让她更安静或更活跃，在这里单独设插话概率。"
      >
        {Object.keys(overrides).length === 0
          ? <div className="ab-muted" style={{ marginBottom: 10 }}>还没有单独设置的群。</div>
          : Object.entries(overrides).map(([gid, o]) => (
            <PercentRow
              key={gid} label={'群 ' + gid}
              value={o.interjectChance} fallback={draft.group.interjectChance}
              write={(v) => setDraft((prev) => { const cur = (prev.group.overrides || {})[gid] || {}; return setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [gid]: { ...cur, interjectChance: v } }) })}
              remove={() => setDraft((prev) => { const n = { ...(prev.group.overrides || {}) }; delete n[gid]; return setPath(prev, 'group.overrides', n) })}
            />
          ))}
        <div className="ab-flex" style={{ marginTop: 8 }}>
          <input className="ab-input" placeholder="群号" value={newGid} onChange={(e) => setNewGid(e.target.value.replace(/\D/g, ''))} />
          <Btn small disabled={!newGid} onClick={() => { setDraft((prev) => setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [newGid]: { interjectChance: prev.group.interjectChance } })); setNewGid('') }}>添加群单独设置</Btn>
        </div>
      </Card>

      <Card title="安全与收发文件" desc="管理收发文件能力与执行终端敏感操作前的二次确认。">
        <div className="ab-section-title" style={{ marginTop: 4 }}>发文件</div>
        <Row label="允许发文件" hint="打开后，你在私聊里可以让她把本机文件当文件发到 QQ，也能按你说的发给白名单里的人或群。">{f.sw('files.enabled')}</Row>
        {draft.files && draft.files.enabled ? (
          <Fragment>
            <Row label="单个文件最大">{f.num('files.maxMB', { min: 1, max: 2048 })}<span className="ab-muted">MB</span></Row>
            <Row label="额外允许的目录" hint="一行一个完整路径。QQ 工作区里的文件一直允许，不用写；留空 = 只能发工作区里的">{f.list('files.dirs', { placeholder: 'D:\\Aurabot\\要发的文件' })}</Row>
            <div className="ab-muted ab-small" style={{ margin: '4px 0 12px' }}>限制：她只能发 QQ 工作区和上面目录里的文件；单个文件有大小上限；发过什么会记在日志里。</div>
          </Fragment>
        ) : null}

        <div className="ab-section-title">收文件</div>
        <Row label="接收单个文件最大" hint="别人发来的文件下载到 QQ 工作区的 qq-inbox 目录；整包读进内存，一条消息最多取 3 个，上限 256MB">{f.num('files.inboundMaxMB', { min: 1, max: 256 })}<span className="ab-muted">MB</span></Row>
        <div className="ab-muted ab-small" style={{ margin: '4px 0 12px' }}>超过这个大小的文件不会被下载，她只知道有人发了个文件。文本类（txt / md / json 等）下载后直接进上下文，太长只给前 6 万字；其它类型落盘，她要用工具才读得到。</div>

        <div className="ab-section-title">危险命令确认</div>
        <Row label="危险命令私聊确认" hint="她在私聊里要执行终端危险命令之前，先发 QQ 私聊问你；回复「确认」才执行，回复「取消」或 60 秒没回就拦下。默认关。">{f.sw('security.dangerConfirm')}</Row>
        <div className="ab-muted ab-small" style={{ marginTop: 4 }}>拦的是真正致命的那几类：删根目录 / 格式化 / 关机重启 / 清空磁盘 / 改注册表关键项 / 下载后直接执行等。普通删除、构建、改文件不受影响。</div>
        <div className="ab-note warn" style={{ marginTop: 8 }}>注意：这是静态规则检测，不是沙箱——动态拼装的命令仍可能绕过，不能替代系统权限隔离。</div>
      </Card>

      <OwnerBrief draft={draft} setDraft={setDraft} />
    </div>
  )
}

export { Group }
