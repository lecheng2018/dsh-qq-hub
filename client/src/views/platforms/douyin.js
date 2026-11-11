import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../../core/react.js'
import { Card, Row, Btn, Switch, Range, Empty, ModOff } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'
import { setPath, timeAgo } from '../../core/utils.js'
import { get, post } from '../../core/http.js'

const DOUYIN_KIND = { watch: '看了', look: '点开看', like: '点赞', comment: '评论', share: '分享给你', dm: '回你私信', 'dry:dm': '试运行·私信', 'dry:like': '试运行·点赞', 'dry:comment': '试运行·评论', error: '没成功' }

/** 抖音：专用浏览器扫码登录、定时刷、点赞 / 评论、在 QQ 上分享给主人，以及她刷过什么。 */
function Douyin({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState('')
  const [login, setLogin] = useState(null) // 扫码进行中：{ shot, message }
  // 只读状态：打开这一页不会启动浏览器
  const load = () => get('/douyin/state').then(setS)
  useEffect(() => { load() }, [])
  const act = (path, label, body) => async () => { setBusy(label); const r = await post(path, body); setBusy(''); toast(r.message || (r.ok ? '好了' : '没成功'), r.ok ? 'ok' : 'err'); load() }
  useEffect(() => {
    if (!login) return undefined
    const t = setInterval(async () => {
      const r = await get('/douyin/login/status')
      if (r.loggedIn) { setLogin(null); toast(r.message, 'ok'); load() } else if (r.ok) setLogin(r)
    }, 2500)
    return () => clearInterval(t)
  }, [Boolean(login)])
  const startLogin = async () => {
    setBusy('login')
    const r = await post('/douyin/login')
    setBusy('')
    if (r.loggedIn) { toast(r.message, 'ok'); load() } else if (r.ok) setLogin(r)
    else toast(r.message || '打不开浏览器', 'err')
  }
  const acct = s && s.account
  const acctText = !acct || acct.unknown ? h('span', { className: 'ab-small ab-muted' }, '还没检查过') :
    h('span', { className: 'ab-small', style: { color: acct.loggedIn ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
      acct.loggedIn ? '已登录：' + (acct.nickname || '') : (acct.message || acct.error || '还没登录'),
      acct.at ? h('span', { className: 'ab-muted' }, ' · ' + timeAgo(acct.at) + '查的') : null)
  const caps = (s && s.caps) || {}
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '刷抖音', right: f.sw('douyin.enabled'), desc: '她用一个专用浏览器（独立的登录资料，不碰你平时用的浏览器）刷抖音：定时打开推荐，一个个点开看，读标题、分类、抖音给的内容摘要和热评，再按自己的性格决定点不点赞、评不评论（特别想让你看的会在评论里 @你）、要不要在 QQ 上分享给你、记住什么。你在 QQ 里发抖音链接，她也能点开看完再聊。浏览器窗口放在屏幕外，不抢前台。总开关默认关：先扫码登录，再打开。' },
      h(Row, { label: '抖音账号', hint: '建议用小号。扫一次码就行，登录状态存在专用浏览器里' },
        h('div', null,
          h('div', { className: 'ab-flex' },
            h(Btn, { small: true, kind: 'primary', onClick: startLogin, disabled: !!busy || !!login }, busy === 'login' ? '正在打开浏览器…' : login ? '等你扫码…' : '扫码登录'),
            h(Btn, { small: true, onClick: async () => { setBusy('check'); const r = await get('/douyin/account'); setBusy(''); setS({ ...(s || {}), account: r }) }, disabled: !!busy }, busy === 'check' ? '检查中…' : '检查登录'),
            acctText),
          login ? h('div', { style: { marginTop: 10, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
            login.shot ? h('img', { src: login.shot, alt: '抖音登录', style: { maxWidth: 360, width: '100%', borderRadius: 10, border: '1px solid var(--ab-line)', background: '#fff' } }) : h('div', { className: 'ab-muted ab-small' }, '二维码还没出来，稍等…'),
            h('div', { className: 'ab-small', style: { flex: 1, minWidth: 160 } },
              h('div', null, login.message || '用抖音 App 扫码'),
              h('div', { className: 'ab-flex', style: { marginTop: 8 } },
                h(Btn, { small: true, onClick: act('/douyin/window', 'win', { visible: true }) }, '显示浏览器窗口'),
                h(Btn, { small: true, onClick: () => setLogin(null) }, '先不登了')))) : null)),
      h(Row, { label: '浏览器窗口', hint: '遇到验证码、扫码后要短信验证时，挪到屏幕上处理' },
        h('div', { className: 'ab-flex' },
          h(Btn, { small: true, onClick: act('/douyin/window', 'win', { visible: true }), disabled: !!busy }, '显示浏览器窗口'),
          h(Btn, { small: true, onClick: act('/douyin/window', 'win', { visible: false }), disabled: !!busy }, '收起窗口'))),
      h(Row, { label: '浏览器路径', hint: '留空 = 自动找 Edge（找不到再找 Chrome / Chromium）' }, f.text('douyin.browserPath', { size: 'wide', placeholder: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' })),
    ),
    h(Card, { title: '主人抖音号', desc: '填你的抖音号或主页链接，点「核对」。核对过之后，她刷到特别想让你看的视频，会在评论里真的 @你（用抖音自己的 @ 选人，按你的账号 id 认人，你会收到抖音通知；认不出你就不发，不会发假 @）。改了输入要重新核对。' },
      h(Row, { label: '你的抖音号 / 主页链接' }, f.text('douyin.owner.input', { size: 'wide', placeholder: '抖音号，或 https://www.douyin.com/user/…' })),
      h('div', { className: 'ab-flex', style: { marginTop: 4 } },
        h(Btn, { small: true, kind: 'primary', onClick: act('/douyin/confirm-owner', 'confirm', { input: ((draft.douyin || {}).owner || {}).input || '' }), disabled: !!busy }, busy === 'confirm' ? '核对中…' : '核对'),
        s && s.owner ? h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, '已核对：' + s.owner.nickname) : h('span', { className: 'ab-small ab-muted' }, '还没核对（不核对就不会 @你）')),
    ),
    h(Card, { title: '抖音私信', desc: '你在抖音上私信她，她会用自己的口气回（只认上面核对过的你，别人的私信不理）。让她找视频的话，她会尝试刷一轮再私信分享给你；这条流程仍需实际环境验证。只在「主动搭话」里设的醒着时间内回。' },
      h(Row, { label: '回你的抖音私信' }, f.sw('douyin.ownerDm')),
      h(Row, { label: '多久看一次' }, f.num('douyin.dmPollMinutes', { min: 1, max: 60 }), h('span', { className: 'ab-muted' }, '分钟'), h(Btn, { small: true, onClick: act('/douyin/dms', 'dms'), disabled: !!busy }, busy === 'dms' ? '正在看…' : '现在看一次')),
    ),
    h(Card, { title: '怎么刷', desc: '只在「主动搭话」里设的醒着时间内自己刷。主人在 QQ 里让她「去刷会儿抖音」也行。' },
      h(Row, { label: '定时自己去刷' }, f.sw('douyin.autoBrowse')),
      h(Row, { label: '多久刷一轮' }, f.range('douyin.intervalHours', 1, 24, 1, (v) => v + ' 小时')),
      h(Row, { label: '每天最多刷' }, f.range('douyin.maxRunsPerDay', 0, 12, 1, (v) => v + ' 轮')),
      h(Row, { label: '一轮看几个' }, f.range('douyin.perRun', 1, 10, 1, (v) => v + ' 个')),
      h(Row, { label: '每天最多看' }, f.num('douyin.maxWatchPerDay', { min: 0, max: 200 }), h('span', { className: 'ab-muted' }, '个（含手动）')),
      h(Row, { label: '每个视频停留', hint: '真的在播放；停得越短越不像真人' }, f.num('douyin.dwellMin', { min: 3 }), h('span', { className: 'ab-muted' }, '～'), f.num('douyin.dwellMax', { min: 3 }), h('span', { className: 'ab-muted' }, '秒')),
      h(Row, { label: '分享到哪', hint: '抖音私信要先在上面核对你的抖音号；没核对或者发不出去时会改发 QQ' }, f.choices('douyin.shareTo', [
        { value: 'douyin', label: '抖音私信', desc: '在抖音里把视频分享给你（只有视频卡片）' },
        { value: 'qq', label: 'QQ 私聊', desc: '她的话 + 视频链接' },
        { value: 'both', label: '两边都发', desc: '抖音里收视频卡片，QQ 上看她说了什么' },
      ])),
      h(Row, { label: '分享给你', hint: '刷到好看的视频，分享给你的积极程度' }, f.choices('douyin.shareBias', [
        { value: 'proactive', label: '积极', desc: '好看有趣就分享' },
        { value: 'normal', label: '适中', desc: '觉得你会喜欢才分享' },
        { value: 'stingy', label: '少分享', desc: '拿不准就不发' },
      ])),
    ),
    h(Card, { title: '每天上限', desc: '刚登录的号前几天上限自动减半（新号猛点赞最容易被风控）。遇到验证码 / 操作频繁当天就停手，看还能看。试运行开着时只记日志不真点。权限在「权限」页单独设（默认仅主人）。' },
      h(Row, { label: '点赞' }, f.num('douyin.caps.like', { min: 0, max: 300 })),
      h(Row, { label: '评论' }, f.num('douyin.caps.comment', { min: 0, max: 30 })),
      h(Row, { label: '分享给你' }, f.num('douyin.caps.share', { min: 0, max: 30 })),
      h(Row, { label: '评论里 @你', hint: '也算在评论次数里' }, f.num('douyin.caps.atOwner', { min: 0, max: 30 })),
      h(Row, { label: '点赞 + 评论合计' }, f.num('douyin.gate.maxWritesPerDay', { min: 1, max: 500 })),
      h(Row, { label: '两次点赞 / 评论间隔' }, f.num('douyin.gate.minWriteGapSec', { min: 0, max: 600 }), h('span', { className: 'ab-muted' }, '秒')),
      h(Row, { label: '新号减半' }, f.num('douyin.gate.newAccountDays', { min: 0, max: 30 }), h('span', { className: 'ab-muted' }, '天')),
    ),
    h(Card, { title: '她刷过什么', right: h('div', { className: 'ab-flex' },
      h(Btn, { small: true, onClick: load }, '刷新'),
      h(Btn, { small: true, kind: 'primary', onClick: act('/douyin/run', 'run'), disabled: !!busy || Boolean(s && s.busy) }, s && s.busy ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在刷…') : '现在刷一轮')) },
      s && s.pauseReason ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '今天先不点赞评论了：' + s.pauseReason + '。要验证的话点上面「显示浏览器窗口」处理，明天自动恢复。') : null,
      s ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } },
        '今天自动刷了 ' + s.runs + ' 轮 · 看了 ' + s.watched + ' · 赞 ' + s.like + '/' + caps.like + ' · 评 ' + s.comment + '/' + caps.comment + ' · 分享 ' + s.share + '/' + caps.share + (s.atOwner ? ' · @你 ' + s.atOwner + '/' + caps.atOwner : '') +
        (s.newAccount ? '（新号，上限减半）' : '') +
        (s.lastRun ? ' · 上次 ' + timeAgo(s.lastRun) : '') +
        (s.lastSkipReason ? ' · 上次没刷成：' + s.lastSkipReason : '')) : null,
      !s ? h(Empty, { icon: '⏳', text: '加载中…' }) : s.history.length === 0 ? h(Empty, { icon: '📱', text: '还没刷过。先扫码登录、打开开关，再点「现在刷一轮」。' }) :
        h('div', { className: 'ab-list' }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, timeAgo(x.at), h('br'), DOUYIN_KIND[x.kind] || x.kind),
          h('div', { className: 'body' },
            x.awemeId ? h('a', { href: 'https://www.douyin.com/video/' + x.awemeId, target: '_blank', rel: 'noreferrer' }, x.title || (x.author ? x.author + ' 的视频' : x.awemeId)) : null,
            x.author && x.title ? h('span', { className: 'ab-muted' }, ' · ' + x.author) : null,
            x.text ? h('div', { className: 'ab-muted' }, (x.atOwner ? '@你 ' : '') + (x.via ? '（' + x.via.map((w) => (w === 'douyin' ? '抖音私信' : 'QQ')).join(' + ') + '）' : '') + x.text) : null)))),
    ),
  )
}



export { Douyin, DOUYIN_KIND }
