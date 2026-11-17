import { useState, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, ListInput, PercentRow, More } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, cx } from '../core/utils.js'
import { OwnerBrief } from './access.js'

/** 卡内可折叠小节：低频配置默认收起，标题行可点开。 */
function FoldSection({ title, desc, right, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="ab-fold-section">
      <div className="ab-flex" style={{ marginTop: 12 }}>
        {/* 与 Card collapse 同款标题行（div+role，避免 button 的默认边框/底色） */}
        <div
          className="ab-fold-head" style={{ margin: 0, flex: 1 }} role="button" tabIndex={0} aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}
        >
          <span className={cx('ab-fold-chev', open && 'open')} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
          </span>
          <h3>{title}</h3>
        </div>
        {right || null}
      </div>
      {desc ? <p className="ab-desc" style={{ marginTop: 2 }}>{desc}</p> : null}
      {open ? <div>{children}</div> : null}
    </div>
  )
}

function Group({ draft, setDraft }) {
  const f = useField(draft, setDraft)
  const overrides = draft.group.overrides || {}
  const [newGid, setNewGid] = useState('')
  return (
    <div className="ab-grid">
      <Card title="消息节奏" desc="人常常一口气发好几句：她等对方说完再一起回，而不是一句一回；模型或工具卡住时也不会无限等。">
        <Row label="连发合并" hint="打开后她会等对方说完再回">{f.sw('merge.enabled')}</Row>
        <Row label="对方停顿多久算说完">{f.range('merge.waitSec', 0.5, 10, 0.5, (v) => v + ' 秒')}</Row>
        <Row label="最多等多久" hint="对方一直在发也最多等这么久">{f.range('merge.maxSec', 2, 30, 1, (v) => v + ' 秒')}</Row>
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
      </Card>

      <Card
        title="怎么说话（分条）"
        desc="她写的 ||| 一定断开；空行算段落；句末标点会按下面的上限攒成条。句子太短不会单独成条，攒够一截才断。"
        more={'换行不代表换消息：一行一个要点的排版会攒成一条发；她真的一行一句话（每行都很短）时，换行就是分条。\n清单和汇报（带小标题、编号列表、代码块）整段发出，拆开会散——用下面的开关控制。'}
      >
        <Row label="群里一条最长" hint="攒到这么长就断开；正常聊天她一般写得比这短">{f.num('reply.groupMaxChars', { min: 10, max: 500 })}<span className="ab-muted">字</span></Row>
        <Row label="私聊一条最长" hint="私聊可以整段说，设大一点更像正常聊天">{f.num('reply.privateMaxChars', { min: 20, max: 2000 })}<span className="ab-muted">字</span></Row>
        <Row label="一轮最多几条" hint="超过就均匀合并，不会把剩下的全塞进最后一条">{f.num('reply.maxBubbles', { min: 1, max: 12 })}<span className="ab-muted">条</span></Row>
        <Row label="清单和汇报整段发" hint="开：带小标题、编号列表、代码块的内容整段发出，拆开会散。关：照样按上面的上限拆">{f.sw('reply.keepReports')}</Row>
      </Card>

      <Card title="群聊行为" desc="群里什么时候必回、什么时候插话、怎么防刷屏。低频的刹车与防 bot 规则默认收起。">
        <FoldSection title="被叫到一定回" defaultOpen desc="被 @、有人引用回复她的消息、或者提到下面这些名字时，她一定会回。">
          <Row label="唤醒词" hint="一行一个">{f.list('group.wakeWords', { placeholder: '大肥鱼\n肥鱼' })}</Row>
        </FoldSection>

        <FoldSection title="插话" defaultOpen desc="没人叫她的时候，她也可能自然地插一句；她看完群里在聊什么，也可以决定不说话。">
          <Row label="插话概率" hint="每条普通消息触发插话的机会">{f.percent('group.interjectChance')}</Row>
          <Row label="冷却" hint="两次插话至少隔多久">{f.range('group.cooldownSec', 0, 600, 10, (v) => v + ' 秒')}</Row>
          <Row label="每小时最多说" hint="这是说话总条数（插话和接着聊都算），不是只看插话次数；额度按小时均摊发放，允许最多三分之一连发">{f.range('group.maxPerHour', 0, 120, 1, (v) => v + ' 条')}</Row>
          <Row label="她感兴趣的话题" hint="群里在聊这些（或她记得相关的事）时更容易插话；一行一个">{f.list('group.interests', { placeholder: '白米饭\n游戏\n追剧' })}</Row>
          <Row label="话题相关度门槛" hint="和她关系不大的话题就不插话；拉到 0 = 不看话题、纯随机">{f.range('group.minRelevance', 0, 1, 0.05, (v) => (v === 0 ? '不看话题' : Math.round(v * 100) + '%'))}</Row>
          <Row label="群冷清时不插话" hint="最近几分钟内消息少于这个数就不插">
            {f.num('group.minRecentMessages', { min: 0 })}<span className="ab-muted">条 / </span>
            {f.num('group.activeWindowSec', { min: 30 })}<span className="ab-muted">秒</span>
          </Row>
          <Row label="静默时段" hint="这段时间不插话（被叫到还是会回）">
            <input className="ab-input sm" type="number" min={0} max={23} value={draft.group.quietHours[0]} onChange={(e) => setDraft(setPath(draft, 'group.quietHours', [Number(e.target.value), draft.group.quietHours[1]]))} />
            <span className="ab-muted">点 到</span>
            <input className="ab-input sm" type="number" min={0} max={23} value={draft.group.quietHours[1]} onChange={(e) => setDraft(setPath(draft, 'group.quietHours', [draft.group.quietHours[0], Number(e.target.value)]))} />
            <span className="ab-muted">点</span>
          </Row>
          <More label="加入话题之后怎么聊">
            {'她被叫到或插上话以后算「加入了话题」：话题还和她相关、她刚说过话，就会接着聊下去（每次看完群里新说的一段再回），不受冷却限制 —— 但照样吃上面的每小时说话额度，不会白送。话题跑偏或者她选择不说话就退出。'}
          </More>
          <Row label="连聊预算" hint="一次入场最多连着接几条 / 最多聊多久；填 0 = 关掉连聊通道（只靠插话）">
            {f.range('group.engagedMaxReplies', 0, 10, 1, (v) => (v === 0 ? '关闭' : v + ' 条'))}
            <span className="ab-muted">/</span>
            {f.range('group.engagedMaxMs', 0, 30 * 60_000, 60_000, (v) => (v === 0 ? '关闭' : Math.round(v / 60_000) + ' 分钟'))}
          </Row>
        </FoldSection>

        <FoldSection title="安全刹车" desc="只防失控（比如和别的机器人聊停不下来）：她在一个群里短时间说太多就歇一会儿，主人 @ 她除外。平时碰不到。">
          <Row label="最多说几次">
            {f.range('group.burstMax', 1, 20, 1, (v) => v + ' 次')}
            <span className="ab-muted">/</span>
            {f.range('group.burstWindowSec', 30, 600, 30, (v) => Math.round(v / 6) / 10 + ' 分钟')}
          </Row>
        </FoldSection>

        <FoldSection title="防同类 bot" desc="防 bot 对聊刷屏：她和一个对象互相针对地接话，已确认是同类 bot 的 2 个来回就停、看不出身份的 4 个来回才停，停的是这一对 30 分钟。">
          <Row label="启用" hint="关掉就完全不判定，她照常按插话概率说话。">{f.sw('group.fishGuard.enabled')}</Row>
          <Row label="按号码认同类 bot" hint="逗号或空格隔开。名单里的人一律当成同类 bot（哪怕名字看不出）">
            {/* 输入过程保留原文（能敲逗号和空格），失焦才解析写回 —— 原来逐键 split+filter，
                敲到分隔符的那一刻内容就被吃掉了 */}
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
        </FoldSection>

        <FoldSection title="按群单独设置" desc="某个群想让她更安静或更活跃，在这里单独设插话概率。">
          {Object.keys(overrides).length === 0
            ? <div className="ab-muted" style={{ marginBottom: 10 }}>还没有单独设置的群。</div>
            : Object.entries(overrides).map(([gid, o]) => (
              <PercentRow
                key={gid} label={'群 ' + gid}
                value={o.interjectChance} fallback={draft.group.interjectChance}
                // 三个写回点全部用函数式 setDraft：旧快照会把刚删的群又写回来（与 persona 分流表同款 bug）
                write={(v) => setDraft((prev) => { const cur = (prev.group.overrides || {})[gid] || {}; return setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [gid]: { ...cur, interjectChance: v } }) })}
                remove={() => setDraft((prev) => { const n = { ...(prev.group.overrides || {}) }; delete n[gid]; return setPath(prev, 'group.overrides', n) })}
              />
            ))}
          <div className="ab-flex">
            <input className="ab-input" placeholder="群号" value={newGid} onChange={(e) => setNewGid(e.target.value.replace(/\D/g, ''))} />
            <Btn small disabled={!newGid} onClick={() => { setDraft((prev) => setPath(prev, 'group.overrides', { ...(prev.group.overrides || {}), [newGid]: { interjectChance: prev.group.interjectChance } })); setNewGid('') }}>添加</Btn>
          </div>
        </FoldSection>
      </Card>

      <Card title="安全与文件" desc="发文件与危险命令确认。平时用不到的话保持默认即可。">
        <FoldSection title="发文件" right={f.sw('files.enabled')} desc="打开后，你在私聊里可以让她把本机文件当文件发到 QQ，也能按你说的发给白名单里的人或群。">
          <Row label="单个文件最大">{f.num('files.maxMB', { min: 1, max: 2048 })}<span className="ab-muted">MB</span></Row>
          <Row label="额外允许的目录" hint="一行一个完整路径。QQ 工作区里的文件一直允许，不用写；留空 = 只能发工作区里的">{f.list('files.dirs', { placeholder: 'D:\\Aurabot\\要发的文件' })}</Row>
          <div className="ab-muted ab-small" style={{ marginTop: 4 }}>限制：她只能发 QQ 工作区和上面目录里的文件；单个文件有大小上限；发过什么会记在日志里。</div>
        </FoldSection>
        <FoldSection title="危险命令确认" right={f.sw('security.dangerConfirm')} desc="她在私聊里要执行终端危险命令之前，先发 QQ 私聊问你；你回复「确认」才执行，回复「取消」或 60 秒没回就拦下。默认关。">
          <div className="ab-muted ab-small">拦的是真正致命的那几类：删根目录 / 格式化 / 关机重启 / 清空磁盘 / 改注册表关键项 / 下载后直接执行等。普通删除、构建、改文件不受影响。</div>
          <div className="ab-note warn" style={{ marginTop: 6 }}>注意：这是静态规则检测，不是沙箱——动态拼装的命令仍可能绕过，不能替代系统权限隔离。</div>
        </FoldSection>
      </Card>

      <OwnerBrief draft={draft} setDraft={setDraft} />
    </div>
  )
}

export { Group }
