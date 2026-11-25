import { useState, useEffect, Fragment, h } from '../core/react.js'
// 注意：`<>...</>` 片段语法编译成 h(Fragment, …)，必须显式 import Fragment，
// 否则运行时抛「Fragment is not defined」，整页白屏。
import { Card, Row, Btn, Empty } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { get, post } from '../core/http.js'

const fmtMB = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : Math.round(n) + ' MB')

// 安装状态卡片：装没装、正在装、装失败
function InstallCard({ st, busy, onInstall, onRefresh, onOpen }) {
  if (!st) return <Card title="浏览器"><Empty icon="⏳" text="读取中…" /></Card>
  if (st.installed) {
    const info = st.info || {}
    return (
      <Card
        title="浏览器已装好"
        desc={`${info.kind === 'chrome' ? '官方 Chrome' : 'Debian Chromium'}　占用 ${fmtMB(info.sizeMB || 0)}`}
        right={<Btn small kind="ghost" onClick={onOpen}>打开目录</Btn>}
      >
        <div className="ab-muted ab-small" style={{ wordBreak: 'break-all' }}>{info.browser}</div>
        <div className="ab-muted ab-small" style={{ marginTop: 4 }}>装在这台机器上，只有插件自己用；没动系统里的东西。</div>
      </Card>
    )
  }
  if (st.job?.state === 'running') {
    return (
      <Card title="正在装…" right={<Btn small kind="ghost" onClick={onRefresh}>刷新</Btn>}>
        <div className="ab-muted">要下几百兆，几分钟很正常。装完这张卡片会自己刷新，不用一直盯着。</div>
        <div className="ab-muted ab-small" style={{ marginTop: 6 }}>{st.job.message}</div>
      </Card>
    )
  }
  const failed = st.job?.state === 'failed'
  return (
    <Card
      title={failed ? '装失败了' : '还没装浏览器'}
      desc="刷抖音、小红书、贴吧这类要开网页的功能，得先有一个浏览器。"
      right={<Btn kind="primary" onClick={onInstall} disabled={busy}>{busy ? '开始了…' : '安装'}</Btn>}
    >
      <div className="ab-muted ab-small">
        会下到插件的数据目录里，<b>不需要管理员权限</b>，也不动系统里的东西。
        优先装官方 Chrome（视频编解码更全），下不动就退回 Debian 的 chromium。
      </div>
      {failed ? <div className="ab-note warn" style={{ marginTop: 8 }}>{st.job.message || st.missing}</div> : null}
      {!failed && st.missing ? <div className="ab-muted ab-small" style={{ marginTop: 6 }}>{st.missing}</div> : null}
    </Card>
  )
}

// 运行状态：谁在用、几个标签页、内存
function LiveCard({ st, onShutdown, onVnc, busy }) {
  const live = st?.live
  if (!live) return null
  const running = live.state === 'ready'
  return (
    <Card
      title="运行状态"
      desc={running ? '浏览器正在跑（多个模块共用这一个进程）' : '现在没在跑。下次要用时会自动起来。'}
      right={running ? <Btn small kind="ghost" onClick={onShutdown} disabled={busy}>立刻关掉</Btn> : null}
    >
      <div className="ab-kv">
        <span>状态</span>
        <span>{running ? '运行中' : '休眠'}</span>
        {live.browser ? <Fragment><span>内核</span><span className="ab-small ab-muted" style={{ wordBreak: 'break-all' }}>{live.browser}</span></Fragment> : null}
        {running ? (
          <Fragment>
            <span>显示</span>
            <span>{live.displayOwned ? `虚拟屏 ${live.display}（无桌面）` : (live.display || '系统显示')}</span>
            <span>标签页</span>
            <span>{live.tabs} 个</span>
            <span>正在用</span>
            <span>{live.active.length ? live.active.join('、') : <span className="ab-muted">没人用</span>}</span>
          </Fragment>
        ) : null}
        <span>可用内存</span>
        <span className={live.freeMB >= 0 && live.freeMB < 600 ? 'ab-warn' : ''}>{live.freeMB >= 0 ? fmtMB(live.freeMB) : '未知'}</span>
      </div>
      {live.displayOwned ? (
        <div style={{ marginTop: 10 }}>
          <Row label="看画面" hint="虚拟屏没人看得见。要完成短信/人机验证，只能用 VNC 连过来自己点">
            <Btn small onClick={() => onVnc('start')} disabled={busy || live.vnc?.running}>开 VNC</Btn>
            <Btn small kind="ghost" onClick={() => onVnc('stop')} disabled={busy || !live.vnc?.running}>关</Btn>
          </Row>
          {live.vnc?.running ? (
            <Row label="连接方式">
              <div className="ab-small">
                <div>端口 <b>{live.vnc.port}</b>　密码 <b>{live.vnc.password}</b></div>
                <div className="ab-muted" style={{ marginTop: 4 }}>
                  {live.vnc.lan
                    ? `用 VNC 客户端连「NAS地址:${live.vnc.port}」。开给局域网了，验完记得关。`
                    : `只允许本机连：先做隧道 ssh -L ${live.vnc.port}:127.0.0.1:${live.vnc.port} 用户@NAS，再连 127.0.0.1:${live.vnc.port}。`}
                </div>
              </div>
            </Row>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

export function Browser({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const r = await get('/browser/status').catch(() => null)
    setSt(r && r.ok ? r : null)
  }
  useEffect(() => { load() }, [])
  // 装的时候自动刷新，不用手点
  useEffect(() => {
    if (st?.job?.state !== 'running') return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [st?.job?.state])

  const act = async (path, body, okText) => {
    setBusy(true)
    try {
      const r = await post(path, body).catch(() => ({ ok: false, message: '请求失败' }))
      toast(r.message || (r.ok ? okText : '没成功'), r.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div className="ab-grid">
      <InstallCard
        st={st}
        busy={busy}
        onInstall={() => act('/browser/install', {}, '开始安装')}
        onRefresh={load}
        onOpen={() => act('/browser/open-folder', {}, '打开了')}
      />
      <LiveCard
        st={st}
        busy={busy}
        onShutdown={() => act('/browser/shutdown', {}, '已关闭')}
        onVnc={(action) => act('/browser/vnc', { action }, '好')}
      />
      <Card title="设置" desc="一个浏览器进程给所有网页类模块共用：内存有限，多开必炸。">
        <Row label="总开关" hint="关掉之后所有要用网页的模块都停（不影响 B站、米家这些纯网络的）">
          {f.sw('browser.enabled')}
        </Row>
        <Row label="浏览器路径" hint="留空 = 用装好的那份；也可以填系统里已有的 Chrome / Edge 完整路径">
          {f.text('browser.chromePath', { size: 'wide', placeholder: '留空自动找' })}
        </Row>
        <Row label="同时用几个" hint="默认 2。机器内存小就调到 1，超了会立刻报忙而不是排队">
          {f.num('browser.maxConcurrent', { min: 1, max: 4, fallback: 2 })}
        </Row>
        <Row label="没人用多久就关" hint="默认 10 分钟。0 = 一直开着（不推荐，会一直占内存）">
          {f.num('browser.idleMinutes', { min: 0, max: 240, fallback: 10 })}<span className="ab-muted">分钟</span>
        </Row>
        <Row label="内存低于多少就不开" hint="默认 600 MB。可用内存不够时不启动，免得把整机拖垮">
          {f.num('browser.minFreeMB', { min: 0, max: 8192, fallback: 600 })}<span className="ab-muted">MB</span>
        </Row>
        <Row label="无头模式" hint="默认关。抖音、小红书会拦无头浏览器，开了可能刷不出内容">
          {f.sw('browser.headless')}
        </Row>
        <Row label="优先官方 Chrome" hint="开着装 Chrome（视频编解码更全）；关着装 Debian 的 chromium（走 apt 源更快）">
          {f.sw('browser.chrome')}
        </Row>
        <Row label="VNC 开给局域网" hint="默认关：VNC 只绑本机，跨机器看要先做 SSH 隧道。打开后局域网能直接连（有随机密码），但浏览器等于敞开，验完记得关">
          {f.sw('browser.vncLan')}
        </Row>
      </Card>
    </div>
  )
}