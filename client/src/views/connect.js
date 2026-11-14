import { useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Choices, More } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { get, post } from '../core/http.js'
import { setPath, cx, timeAgo } from '../core/utils.js'

function SnowLumaAuth({ running, toast, onChange }) {
  const [s, setS] = useState(null)
  const load = () => get('/snowluma/login-check').then(setS)
  useEffect(() => { if (running) load() }, [running])
  if (!running) return <span className="ab-muted ab-small">启动后插件会自动管理控制台密码，你不用设置。</span>
  if (!s) return <span className="ab-muted ab-small"><i className="ab-spin" /> 检查中…</span>
  if (s.ok) return <PasswordPeek auto={s.passwordAuto} />
  return (
    <div>
      <div className="ab-small" style={{ color: 'var(--ab-warn)' }}>插件登不上 SnowLuma 控制台：{s.message || ''}。多半是之前手动设过密码。</div>
      <div style={{ marginTop: 6 }}>
        <Btn
          small kind="primary"
          onClick={async () => {
            if (!confirm('会先停掉 SnowLuma、清掉它的旧控制台密码，再用插件生成的新密码重新启动。机器人号需要稍后重新接入。继续吗？')) return
            const r = await post('/snowluma/reset-password'); toast(r.message); load(); onChange && onChange()
          }}
        >
          重置为自动密码
        </Btn>
      </div>
    </div>
  )
}

/** 控制台密码只显示托管状态；明文不经过面板 API。 */
function PasswordPeek({ auto }) {
  return (
    <div>
      <div className="ab-small" style={{ color: 'var(--ab-ok)' }}>{auto ? '✓ 控制台密码由插件自动管理' : '✓ 用的是你设的控制台密码'}</div>
      <div className="ab-muted ab-small">明文请在本机配置文件中查看，面板不再显示或复制。</div>
    </div>
  )
}

/** 在面板里阅读并同意 SnowLuma 的用户协议和隐私说明（必须由用户本人勾选、点击）。 */
function Agreement({ running, toast, onChange }) {
  const [a, setA] = useState(null)
  const [tab, setTab] = useState(0)
  const [agree, setAgree] = useState(false)
  const load = () => get('/snowluma/agreements').then(setA)
  useEffect(() => { if (running) load() }, [running])
  if (!running) return <span className="ab-muted ab-small">先启动 SnowLuma。</span>
  if (!a) return <span className="ab-muted ab-small"><i className="ab-spin" /> 读取协议…</span>
  if (!a.ok) return <span className="ab-small" style={{ color: 'var(--ab-warn)' }}>读不到协议：{a.message}</span>
  if (!a.consentRequired) return <span className="ab-small" style={{ color: 'var(--ab-ok)' }}>✓ 已同意 SnowLuma 的用户协议和隐私说明（版本 {a.version}）</span>
  const doc = a.documents[tab] || a.documents[0]
  return (
    <div style={{ width: '100%' }}>
      <div className="ab-seg" style={{ marginBottom: 8 }}>
        {a.documents.map((d, i) => <button key={d.id} type="button" className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{d.title.split('/')[0].trim()}</button>)}
      </div>
      {doc ? <div className="ab-logs" style={{ maxHeight: 260, padding: '12px 14px', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{doc.text}</div> : null}
      <label className="ab-flex" style={{ marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ accentColor: 'var(--ab-sea)', width: 16, height: 16 }} />
        <span>我已阅读并同意以上 SnowLuma 用户协议和隐私说明</span>
      </label>
      <div className="ab-flex" style={{ marginTop: 8 }}>
        <Btn
          kind="primary" small disabled={!agree}
          onClick={async () => { const r = await post('/snowluma/consent', { version: a.version, agree: true }); toast(r.ok ? '已同意' : r.message, r.ok ? 'ok' : 'err'); load(); onChange && onChange() }}
        >
          同意
        </Btn>
        <span className="ab-muted ab-small">SnowLuma 是独立的第三方项目，仅限个人非商业使用；请用小号。</span>
      </div>
    </div>
  )
}

/** 用什么接 QQ：插件帮你管 SnowLuma，或接你已有的 OneBot v11 机器人。 */
function GatewayChoice({ draft, setDraft }) {
  return (
    <Choices
      value={draft.gateway || 'snowluma'}
      onChange={(v) => setDraft(setPath(draft, 'gateway', v))}
      options={[
        { value: 'snowluma', label: '用 SnowLuma（Windows，推荐）', desc: '插件帮你启动、接入机器人号、断线重连' },
        { value: 'onebot', label: '接我已有的 OneBot 机器人', desc: 'NapCat、LLOneBot、Lagrange 等；Linux / Docker 部署选这个' },
      ]}
    />
  )
}

/** 已有 OneBot 机器人的地址和令牌。 */
function OneBotFields({ draft, f }) {
  return (
    <Fragment>
      <Row label="WebSocket 地址" hint="正向 WebSocket（OneBot v11），收消息靠它，必填。DSH 在容器里的话，要填容器能访问到的地址">
        {f.text('snowluma.wsUrl', { size: 'wide', placeholder: 'ws://127.0.0.1:3001' })}
      </Row>
      <Row label="WebSocket 令牌" hint="对方设了 access_token 就填，没设留空">
        {f.text('snowluma.wsToken', { type: 'password', placeholder: draft.snowluma.wsTokenSet ? '已保存' : '没有就留空' })}
      </Row>
      <Row label="HTTP 地址" hint="可选。填了就用 HTTP 调接口，不填就都走 WebSocket">
        {f.text('snowluma.httpUrl', { size: 'wide', placeholder: 'http://127.0.0.1:3000' })}
      </Row>
      <Row label="HTTP 令牌">
        {f.text('snowluma.httpToken', { type: 'password', placeholder: draft.snowluma.httpTokenSet ? '已保存' : '没有就留空' })}
      </Row>
    </Fragment>
  )
}

const STATE_TEXT = { connected: '已连上', connecting: '连接中', disconnected: '断开了，正在重连', stopped: '没启动（总开关关着）', unconfigured: '还没配置' }

function Connect({ st, draft, setDraft, toast, reload, openWizard }) {
  const f = useField(draft, setDraft)
  const sl = st.snowluma
  const [procs, setProcs] = useState(null)
  const conn = st.onebot.state === 'connected'
  const loadProcs = async () => { const r = await get('/snowluma/processes'); setProcs(r.list || []); if (!r.ok) toast(r.message) }
  const act = (p) => async () => { const r = await post(p); toast(r.message || (r.ok ? '好了' : '没成功')); reload() }
  const login = st.onebot.login
  const external = draft.gateway === 'onebot'
  const testBtns = (
    <div className="ab-flex" style={{ marginTop: 8 }}>
      <Btn small onClick={async () => { const r = await get('/onebot/test'); toast(r.message) }}>测试连接</Btn>
      <Btn small onClick={async () => { const r = await post('/onebot/reconnect'); toast(r.message, r.ok ? 'ok' : 'err'); reload() }}>重新连接</Btn>
    </div>
  )
  return (
    <div className="ab-grid">
      <Card title="用什么接 QQ" right={openWizard ? <Btn small kind="ghost" onClick={openWizard}>重新走一遍设置向导</Btn> : null}>
        <GatewayChoice draft={draft} setDraft={setDraft} />
      </Card>

      {external ? (
        <Card title="接上 QQ（已有的 OneBot 机器人）" desc="让 OneBot 服务登录机器人号，把它的正向 WebSocket 地址填在这里，保存后插件就会去连。连上后会先核对登录的是不是机器人号，不是就断开。">
          <OneBotFields draft={draft} f={f} />
          <Row label="机器人 QQ 号">{f.text('botQQ')}</Row>
          {testBtns}
        </Card>
      ) : (
        <Card title="接上 QQ（SnowLuma）" desc="SnowLuma 是让机器人号上线的 QQ 网关，按协议要你自己下载并同意它的用户协议；启动、密码、接入、断线重连都交给 QQ Hub。">
          <div className="ab-steps">
            <div className={cx('ab-step', sl.installed && 'done')}>
              <div>
                <b>下载 SnowLuma</b>
                <div className="ab-muted ab-small">官方发布页下载 Windows 完整版（名字类似 SnowLuma-v2.x.x-win-x64.zip，不带 lite）。</div>
                <div style={{ marginTop: 6 }}><Btn small onClick={() => window.open(sl.downloadPage, '_blank')}>打开下载页 ↗</Btn></div>
              </div>
            </div>
            <div className={cx('ab-step', sl.installed && 'done')}>
              <div>
                <b>解压到一个纯英文的目录</b>
                <div className="ab-muted ab-small">推荐 C:\Aurabot\snowluma。解压后这个目录里应该直接能看到 index.mjs 和 node.exe。</div>
                <div className="ab-flex" style={{ marginTop: 6 }}>{f.text('snowluma.dir', { size: 'wide', placeholder: 'C:\\Aurabot\\snowluma' })}</div>
                {!sl.installed && sl.reason
                  ? <div className="ab-small" style={{ color: 'var(--ab-warn)', marginTop: 4 }}>{sl.reason}</div>
                  : sl.installed ? <div className="ab-small" style={{ color: 'var(--ab-ok)', marginTop: 4 }}>找到了 SnowLuma v{sl.version}</div> : null}
              </div>
            </div>
            <div className={cx('ab-step', sl.running && 'done')}>
              <div>
                <b>启动</b>
                <div className="ab-muted ab-small">后台运行，不弹窗口；以后会跟着 DSH 自动启动。</div>
                <div className="ab-flex" style={{ marginTop: 6 }}>
                  <Btn small kind="primary" disabled={!sl.installed || sl.running} onClick={act('/snowluma/start')}>{sl.running ? '已在运行' : '启动'}</Btn>
                  {sl.owns ? <Btn small kind="danger" onClick={act('/snowluma/stop')}>停止</Btn> : null}
                </div>
                <div style={{ marginTop: 6 }}><SnowLumaAuth running={sl.running} toast={toast} onChange={reload} /></div>
              </div>
            </div>
            <div className={cx('ab-step', sl.consented && 'done')}>
              <div>
                <b>阅读并同意 SnowLuma 的用户协议</b>
                <div className="ab-muted ab-small" style={{ marginBottom: 6 }}>同意之前 SnowLuma 不会工作。</div>
                <Agreement running={sl.running} toast={toast} onChange={reload} />
              </div>
            </div>
            <div className={cx('ab-step', conn && login && login.uin === draft.botQQ && 'done')}>
              <div>
                <b>登录机器人号并接入</b>
                <div className="ab-muted ab-small">在电脑上另开一个 QQ 登录机器人号 {draft.botQQ}（可以最小化），然后点「接入机器人号」。你的大号照常开着——插件只接机器人号。</div>
                <div className="ab-flex" style={{ marginTop: 6 }}>
                  <Btn small kind="primary" disabled={!sl.running} onClick={act('/snowluma/attach')}>接入机器人号</Btn>
                  <Btn small disabled={!sl.running} onClick={loadProcs}>看看有哪些 QQ 进程</Btn>
                  <Btn small onClick={async () => { const r = await get('/onebot/test'); toast(r.message) }}>测试连接</Btn>
                </div>
                {sl.lastAttach && sl.lastAttach.at ? (
                  <div className="ab-small" style={{ marginTop: 4, color: sl.lastAttach.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' }}>
                    {timeAgo(sl.lastAttach.at)}：{sl.lastAttach.message}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {procs ? (
            <div style={{ marginTop: 14 }}>
              {procs.length === 0 ? <div className="ab-muted">没找到 QQ 进程。</div> : (
                <table className="ab-table">
                  <thead><tr>{['进程', '登录的号', '昵称', '状态', ''].map((x) => <th key={x}>{x}</th>)}</tr></thead>
                  <tbody>
                    {procs.map((p) => (
                      <tr key={p.pid}>
                        <td>{p.pid}</td>
                        <td>{p.uin || '识别不出'}</td>
                        <td>{p.nickname || '—'}</td>
                        <td>{p.injected ? (p.connected ? '已接入' : '已注入，连接中') : '未接入'}</td>
                        <td>{p.isBot ? <span className="ab-badge">机器人号</span> : <span className="ab-muted ab-small">不会碰</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </Card>
      )}

      <Card
        title="QQ 会话放在哪"
        desc="每个 QQ 私聊 / 群都是 DSH 里「QQ Hub」工作区下的一个会话，她在会话里读写文件也在这个文件夹。改了以后新开的会话放到新位置。"
        more={'想把她已有的会话全部挪到新位置：改完保存后去「概览」点「重新开始所有 QQ 会话」（旧会话在 DSH 侧栏的归档里还能找到）。'}
      >
        <Row label="工作区文件夹" hint="填完整路径（比如 D:\\Aurabot\\qq-chats）；留空 = 默认位置">
          {f.text('workspaceDir', { size: 'wide', placeholder: st.workspaceDir || '' })}
        </Row>
        <div className="ab-muted ab-small">现在用的：{st.workspaceDir || '—'}</div>
      </Card>

      <Card title="连接状态">
        <div className="ab-kv">
          <span>QQ 网关</span>
          <span>
            <span className="ab-flex"><i className={cx('ab-dot', conn ? 'ok' : st.onebot.state === 'connecting' ? 'warn' : 'err')} />{STATE_TEXT[st.onebot.state] || st.onebot.state}</span>
          </span>
          <span>登录的号</span>
          <span>{login ? login.nickname + '（' + login.uin + '）' + (login.uin !== draft.botQQ ? ' ⚠ 不是机器人号！' : '') : '—'}</span>
          <span>HTTP</span><span>{st.onebot.endpoint.httpUrl || '—'}</span>
          <span>WebSocket</span><span>{st.onebot.endpoint.wsUrl || '—'}</span>
        </div>
        {!conn && st.onebot.problem ? <div className="ab-note warn" style={{ marginTop: 10 }}>{st.onebot.problem}</div> : null}
        <div className="ab-flex" style={{ marginTop: 10 }}>
          <Btn small onClick={async () => { const r = await post('/onebot/reconnect'); toast(r.message, r.ok ? 'ok' : 'err'); reload() }}>重新连接</Btn>
        </div>
      </Card>

      {external ? null : (
        <Card title="高级" desc="一般不用动：地址和令牌会自动从 SnowLuma 的配置里读。">
          <Row label="机器人 QQ 号">{f.text('botQQ')}</Row>
          <Row label="控制台端口">{f.num('snowluma.webuiPort', { min: 1, max: 65535 })}</Row>
          <Row label="控制台密码" hint="默认由插件自动生成。想自己定一个就填在这里，保存后会真的改到 SnowLuma 上（至少 10 位，要有大小写字母和符号）">
            {f.text('snowluma.webuiPassword', { type: 'password', placeholder: draft.snowluma.webuiPasswordSet ? (draft.snowluma.passwordAuto ? '自动管理中（不改就留空）' : '已保存（不改就留空）') : '留空 = 自动' })}
          </Row>
          <Row label="SnowLuma 自己的控制台" hint="一般用不到，想看它的原始界面时用">
            <Btn small disabled={!sl.running} onClick={() => window.open(sl.webui, '_blank')}>打开 ↗</Btn>
          </Row>
          <Row label="随 DSH 自动启动 SnowLuma">{f.sw('snowluma.autoStart')}</Row>
          <Row label="自动接入机器人号" hint="断线后自动重新接入，只接机器人号">{f.sw('snowluma.autoAttach')}</Row>
          <Row label="手动 HTTP 地址" hint="留空 = 自动">{f.text('snowluma.httpUrl', { placeholder: 'http://127.0.0.1:3000' })}</Row>
          <Row label="手动 WS 地址" hint="留空 = 自动">{f.text('snowluma.wsUrl', { placeholder: 'ws://127.0.0.1:3001' })}</Row>
          <Row label="手动 HTTP 令牌">{f.text('snowluma.httpToken', { type: 'password', placeholder: draft.snowluma.httpTokenSet ? '已保存' : '留空 = 自动' })}</Row>
          <Row label="手动 WS 令牌">{f.text('snowluma.wsToken', { type: 'password', placeholder: draft.snowluma.wsTokenSet ? '已保存' : '留空 = 自动' })}</Row>
        </Card>
      )}
    </div>
  )
}

export { Connect, GatewayChoice, OneBotFields, SnowLumaAuth, PasswordPeek, Agreement }
