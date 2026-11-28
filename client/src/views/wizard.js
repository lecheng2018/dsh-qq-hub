import { useState, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Choices } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { cx, openExternal } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { GatewayChoice, OneBotFields, SnowLumaAuth, Agreement } from './connect.js'

const WIZ_STEPS = ['你们的 QQ 号', '接 QQ 网关', '启动并同意协议', '连上机器人号', '完成']

function Wizard({ st, draft, setDraft, save, toast, reload, onClose }) {
  const [step, setStep] = useState(() => { try { return Number(localStorage.getItem('qq-hub.wiz') || 0) } catch (e) { return 0 } })
  const go = (i) => { setStep(i); try { localStorage.setItem('qq-hub.wiz', String(i)) } catch (e) {} }
  const f = useField(draft, setDraft)
  const sl = st.snowluma
  const conn = st.onebot.state === 'connected'
  const login = st.onebot.login
  const [procs, setProcs] = useState(null)
  const [live, setLive] = useState('dry')
  const qqOk = /^\d{5,11}$/.test(draft.botQQ || '') && /^\d{5,11}$/.test(draft.ownerQQ || '') && draft.botQQ !== draft.ownerQQ
  const external = draft.gateway === 'onebot'
  const verified = conn && login && String(login.uin) === String(st.config.botQQ) && !st.onebot.problem
  const canNext = [qqOk, external ? Boolean(draft.snowluma.wsUrl || st.config.snowluma.wsUrl) : sl.installed, external || (sl.running && sl.consented), verified, true][step]
  const next = async () => {
    if ((step === 0 || step === 1) && !(await save({ ...draft, enabled: true }))) return
    go(Math.min(step + 1, WIZ_STEPS.length - 1))
    reload()
  }
  const useExisting = async () => {
    const r = await post('/setup/done', { existingConnection: true })
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) { try { localStorage.removeItem('qq-hub.wiz') } catch (e) {} reload(); onClose && onClose() }
  }
  const body = [
    // 0. QQ 号
    (
      <div key="s0">
        <p className="ab-desc">大肥鱼需要一个自己的 QQ 号（机器人号），还要知道谁是她的主人。</p>
        <Row label="机器人 QQ 号" hint="强烈建议用小号：非官方 QQ 工具有被限制的风险">{f.text('botQQ', { placeholder: '例如 123456789' })}</Row>
        <Row label="你的 QQ 号（主人）" hint="群管、操作电脑这些只听主人的">{f.text('ownerQQ', { placeholder: '你的大号' })}</Row>
        <Row label="她怎么称呼你">{f.text('ownerName', { placeholder: '主人' })}</Row>
        {draft.botQQ && draft.ownerQQ && draft.botQQ === draft.ownerQQ ? <div className="ab-note err">机器人号和主人号不能是同一个。</div> : null}
      </div>
    ),
    // 1. SnowLuma，或接已有的 OneBot 机器人
    external ? (
      <div key="s1">
        <GatewayChoice draft={draft} setDraft={setDraft} />
        <p className="ab-desc" style={{ marginTop: 10 }}>让你的 OneBot 服务（NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma……）登录机器人号，把它的正向 WebSocket 地址填在下面。插件只连接，不会启动或注入任何东西。</p>
        <OneBotFields draft={draft} f={f} />
      </div>
    ) : (
      <div key="s1">
        <GatewayChoice draft={draft} setDraft={setDraft} />
        <p className="ab-desc" style={{ marginTop: 10 }}>SnowLuma 是让机器人号上线的 QQ 网关。它的协议不允许别的程序自动下载安装，所以这一步要你自己来（只用做一次）。</p>
        <div className="ab-steps">
          <div className="ab-step">
            <div>
              <b>下载</b>
              <div className="ab-muted ab-small">下载 Windows 完整版，文件名类似 SnowLuma-v2.x.x-win-x64.zip（不带 lite）。</div>
              <div style={{ marginTop: 6 }}><Btn small onClick={() => openExternal(sl.downloadPage)}>打开下载页 ↗</Btn></div>
            </div>
          </div>
          <div className={cx('ab-step', sl.installed && 'done')}>
            <div>
              <b>解压到纯英文目录</b>
              <div className="ab-muted ab-small">推荐 C:\Aurabot\snowluma，解压后目录里能直接看到 index.mjs。</div>
              <div className="ab-flex" style={{ marginTop: 6 }}>
                {f.text('snowluma.dir', { size: 'wide', placeholder: 'C:\\Aurabot\\snowluma' })}
                <Btn small onClick={async () => { await save(draft); reload() }}>检查</Btn>
              </div>
              <div className="ab-small" style={{ marginTop: 4, color: sl.installed ? 'var(--ab-ok)' : 'var(--ab-warn)' }}>{sl.installed ? '✓ 找到了 SnowLuma v' + sl.version : sl.reason}</div>
            </div>
          </div>
        </div>
      </div>
    ),
    // 2. 启动 + 协议（接自己的 OneBot 时不用）
    external ? (
      <div key="s2"><p className="ab-desc">用的是你自己的 OneBot 服务，这一步不用做，直接下一步。</p></div>
    ) : (
      <div key="s2">
        <p className="ab-desc">点启动后它在后台运行（不弹窗口），控制台密码由插件自动生成和保存，你不用记。</p>
        <div className="ab-flex" style={{ marginBottom: 10 }}>
          <Btn kind="primary" small disabled={sl.running} onClick={async () => { toast('正在启动…'); const r = await post('/snowluma/start'); toast(r.message); reload() }}>{sl.running ? '✓ 已在运行' : '启动 SnowLuma'}</Btn>
          <SnowLumaAuth running={sl.running} toast={toast} onChange={reload} />
        </div>
        <Agreement running={sl.running} toast={toast} onChange={reload} />
      </div>
    ),
    // 3. 接入
    (
      <div key="s3">
        {external
          ? <p className="ab-desc">确认你的 OneBot 服务登录的是机器人号 {st.config.botQQ || ''}，然后点「测试连接」。插件连上后会先核对登录的号，不是机器人号就断开。</p>
          : <p className="ab-desc">在这台电脑上另开一个 QQ，登录机器人号 {st.config.botQQ || ''}（可以最小化）。你的大号 QQ 照常开着就行——插件只会接入机器人号，绝不碰别的号。</p>}
        {external
          ? (
            <div className="ab-flex">
              <Btn kind="primary" small onClick={async () => { const r = await post('/onebot/reconnect'); toast(r.message, r.ok ? 'ok' : 'err'); reload() }}>连接</Btn>
              <Btn small onClick={async () => { const r = await get('/onebot/test'); toast(r.message) }}>测试连接</Btn>
            </div>
          )
          : (
            <div className="ab-flex">
              <Btn kind="primary" small onClick={async () => { const r = await post('/snowluma/attach'); toast(r.message); setTimeout(reload, 1500) }}>接入机器人号</Btn>
              <Btn small onClick={async () => { const r = await get('/snowluma/processes'); setProcs(r.list || []); if (!r.ok) toast(r.message) }}>看看有哪些 QQ 进程</Btn>
              <Btn small onClick={async () => { const r = await get('/onebot/test'); toast(r.message) }}>测试连接</Btn>
            </div>
          )}
        {sl.lastAttach && sl.lastAttach.at ? <div className="ab-small" style={{ marginTop: 8, color: sl.lastAttach.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' }}>{sl.lastAttach.message}</div> : null}
        {conn && login
          ? <div className="ab-note" style={{ marginTop: 10 }}>{login.uin === st.config.botQQ ? '✓ 连上了：' + login.nickname + '（' + login.uin + '）' : '⚠ 连上的是 ' + login.uin + '，不是机器人号'}</div>
          : <div className="ab-muted ab-small" style={{ marginTop: 10 }}>接入后需要十几秒识别登录状态，稍等一下会自动刷新。</div>}
        {procs ? (
          <div className="ab-table-wrap" style={{ marginTop: 10 }}>
            <table className="ab-table">
              <tbody>
                {procs.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.pid}</td>
                    <td>{p.uin || '识别不出'}</td>
                    <td>{p.nickname || ''}</td>
                    <td>{p.isBot ? <span className="ab-badge">机器人号</span> : <span className="ab-muted ab-small">不会碰</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    ),
    // 4. 完成
    (
      <div key="s4">
        <p className="ab-desc">都准备好了！最后选一下她怎么上线：</p>
        <Choices
          value={live} onChange={setLive}
          options={[
            { value: 'dry', label: '先试运行', desc: '她会照常思考，但只写进日志、不真的发出去。看几条没问题再在右上角关掉试运行' },
            { value: 'live', label: '直接上线', desc: '马上开始真的回 QQ 消息' },
          ]}
        />
        <div className="ab-flex" style={{ marginTop: 12 }}>
          <Btn small onClick={async () => { await save({ ...draft, enabled: true, dryRun: false }); const r = await post('/test-send'); toast(r.message); await save({ ...draft, enabled: true, dryRun: live === 'dry' }) }}>给我发一条自测消息</Btn>
        </div>
      </div>
    ),
  ][step]
  return (
    <div className="ab-card ab-wiz-card">
      <div className="ab-flex" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>设置向导</h3>
        <span className="ab-muted ab-small">第 {step + 1} / {WIZ_STEPS.length} 步 · {WIZ_STEPS[step]}</span>
        <div className="ab-spacer" />
        {st.config.setupDone && onClose ? <Btn small kind="ghost" onClick={onClose}>关闭向导</Btn> : null}
      </div>
      <div className="ab-wiz-bar">
        {WIZ_STEPS.map((s, i) => (
          <button key={s} type="button" className={cx('seg', i < step && 'done', i === step && 'on')} onClick={() => i <= step && go(i)} title={s}><span>{s}</span></button>
        ))}
      </div>
      {verified && !st.config.setupDone ? (
        <div className="ab-note" style={{ marginTop: 12 }}>
          机器人号已经连接并核对通过。{' '}
          <Btn small onClick={useExisting}>使用现有连接，进入面板</Btn>
        </div>
      ) : null}
      <div style={{ minHeight: 220, marginTop: 14 }}>{body}</div>
      <div className="ab-flex" style={{ marginTop: 16, borderTop: '1px solid var(--ab-line)', paddingTop: 12 }}>
        {step > 0 ? <Btn kind="ghost" onClick={() => go(step - 1)}>上一步</Btn> : null}
        <div className="ab-spacer" />
        {step < WIZ_STEPS.length - 1
          ? <Btn kind="primary" disabled={!canNext} onClick={next}>下一步</Btn>
          : (
            <Btn
              kind="primary"
              onClick={async () => {
                if (!(await save({ ...draft, enabled: true, dryRun: live === 'dry' }))) return
                const r = await post('/setup/done'); toast(r.message, r.ok ? 'ok' : 'err')
                if (r.ok) { try { localStorage.removeItem('qq-hub.wiz') } catch (e) {} reload(); onClose && onClose() }
              }}
            >
              完成，让大肥鱼上线
            </Btn>
          )}
      </div>
    </div>
  )
}

export { Wizard, WIZ_STEPS }
