import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../../core/react.js'
import { Card, Row, Btn, Switch, Range, Empty, ModOff } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'
import { setPath, timeAgo } from '../../core/utils.js'
import { get, post } from '../../core/http.js'

const HEYBOX_KIND = { browse: '逛了一圈', like: '点了赞', comment: '发了评论', post: '发了帖', delete: '删了帖' }


/** 「小黑盒」页：账号、逛法、额度、热榜预览、发帖分区与自检提醒、逛过什么。 */
function Heybox({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState('')
  const [hot, setHot] = useState(null)
  const [cookieText, setCookieText] = useState('')
  const load = () => get('/heybox/state').then(setS)
  useEffect(() => { load() }, [])
  const act = (path, label, body) => async () => {
    setBusy(label)
    const r = await post(path, body)
    setBusy('')
    toast(r.message || (r.ok ? '好了' : '没成功'), r.ok === false ? 'err' : 'ok')
    load()
  }
  const checkAccount = async () => {
    setBusy('account')
    const r = await get('/heybox/account')
    setBusy('')
    toast(r.message || (r.loggedIn ? '已登录：' + (r.nickname || '') : '没登录'), r.loggedIn ? 'ok' : 'err')
    load()
  }
  const loadHot = async () => {
    setBusy('hot')
    const r = await post('/heybox/hot')
    setBusy('')
    if (r.ok === false) { toast(r.message || '拉不到热榜', 'err'); return }
    setHot(r)
    load()
  }
  const saveCookie = async () => {
    if (!cookieText.trim()) { toast('先把 Cookie 粘进来', 'err'); return }
    setBusy('cookie')
    const r = await post('/heybox/login-cookie', { cookie: cookieText })
    setBusy('')
    toast(r.message || (r.ok ? '存好了' : '没成功'), r.ok === false ? 'err' : 'ok')
    if (r.ok) setCookieText('')
    load()
  }
  const acct = s && s.account
  const acctText = !acct || !acct.checkedAt ? h('span', { className: 'ab-small ab-muted' }, '还没检查过') :
    h('span', { className: 'ab-small', style: { color: acct.loggedIn ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
      acct.loggedIn ? '已登录：' + (acct.nickname || '') + (acct.heyboxId ? '（id ' + acct.heyboxId + '）' : '') : (acct.message || '还没登录'),
      acct.checkedAt ? h('span', { className: 'ab-muted' }, ' · ' + timeAgo(acct.checkedAt) + '查的') : null)
  const quota = (s && s.quota) || {}
  const left = (s && s.left) || {}
  const limits = (s && s.limits) || {}
  return h('div', { className: 'ab-grid' },
    h(Card, {
      title: '刷小黑盒', right: f.sw('heybox.enabled'),
      desc: '用你的小黑盒账号逛游戏社区：定时看信息流、读帖子正文和热评，按性格决定点不点赞、评不评论；她自己会写帖子（先看热榜找角度，再看社区高赞帖在聊什么，配图走小黑盒图床），发完把链接报给你。写操作各有权限（「权限」页，默认仅主人），每天有额度上限。',
    },
      h(Row, { label: '小黑盒账号', hint: '从浏览器登录后把整串 Cookie 粘到下面。pkey 必须有；想让它能点赞评论发帖，还要有 x_xhh_tokenid（F12 → Application → Cookies 里能复制到）' },
        h('div', null,
          h('div', { className: 'ab-flex' },
            h(Btn, { small: true, onClick: checkAccount, disabled: !!busy }, busy === 'account' ? '检查中…' : '检查登录'),
            acctText),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('textarea', {
              className: 'ab-input', rows: 3, spellCheck: false,
              style: { flex: 1, minWidth: 260, fontFamily: 'monospace', fontSize: 12 },
              placeholder: 'pkey=…; heybox_id=…; x_xhh_tokenid=…',
              value: cookieText, onChange: (e) => setCookieText(e.target.value),
            }),
            h(Btn, { small: true, kind: 'primary', onClick: saveCookie, disabled: !!busy }, busy === 'cookie' ? '保存中…' : '保存 Cookie')),
          s && s.hasCookie
            ? h('div', { className: 'ab-small', style: { marginTop: 6, color: s.hasToken ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
              s.hasToken ? '✓ 有 pkey 和 x_xhh_tokenid，读写都能用' : '⚠ 只有 pkey，没有 x_xhh_tokenid：点赞 / 评论 / 发帖大概率会被拒')
            : null)),
    ),
    h(Card, {
      title: '她的逛法', desc: '只在「主动搭话」里设的醒着时间内自己逛。主人在 QQ 里让她「去逛逛小黑盒」也行。逛是只读的，不会乱点赞评论。',
    },
      h(Row, { label: '定时自己去逛' }, f.sw('heybox.autoBrowse')),
      h(Row, { label: '多久逛一圈' }, f.range('heybox.intervalHours', 1, 24, 1, (v) => v + ' 小时')),
      h(Row, { label: '一圈看几条' }, f.range('heybox.perRun', 1, 10, 1, (v) => v + ' 条')),
      h(Row, { label: '每天最多逛' }, f.range('heybox.maxRunsPerDay', 0, 12, 1, (v) => v + ' 轮')),
    ),
    h(Card, {
      title: '每天上限',
      desc: '小黑盒的帖详情和搜索接口查太勤会弹验证码（还可能连坐浏览器登录态），所以额度别设太大。搜索被挡时她会自动降级去翻信息流，不会反复硬试。',
    },
      h(Row, { label: '点赞' }, f.num('heybox.likeDaily', { min: 0, max: 60 }), h('span', { className: 'ab-muted' }, '次/天')),
      h(Row, { label: '评论' }, f.num('heybox.commentDaily', { min: 0, max: 30 }), h('span', { className: 'ab-muted' }, '条/天')),
      h(Row, { label: '发帖' }, f.num('heybox.maxPostsPerDay', { min: 0, max: 5 }), h('span', { className: 'ab-muted' }, '篇/天（建议别超过 3）')),
      h(Row, { label: '发帖风格', hint: '她写帖时按这个口吻来。也可以让她单次换：跟她说「用日记风格发一篇」' },
        f.select('heybox.postStyle', [
          { value: 'diary', label: '大肥鱼日记', desc: '第一人称随手记，跟空间日记一个味，120-300字' },
          { value: 'news', label: '热搜文', desc: '报道新闻体，摆具体数字，200-800字' },
          { value: 'mix', label: '肥鱼热搜', desc: '用日记口吻写热搜，150-500字' },
        ], { width: 220 })),
      h(Row, { label: '发帖默认分区', hint: '文章帖必须挂分区，否则会报「请添加分区」。这三个是实测存在的' },
        f.select('heybox.defaultTopic', [
          { value: 7214, label: '盒友杂谈', desc: '最常用，什么都能聊' },
          { value: 18745, label: '数码硬件', desc: '显卡、笔记本、外设' },
          { value: 806933, label: 'AI', desc: 'AI 相关，容易涨浏览' },
        ], { width: 200 })),
      s ? h(Row, { label: '今天已经用掉', hint: '到 0 就等明天，或者手动清零（重启一次会话不会重置）' },
        h('div', { className: 'ab-flex' },
          h('span', { className: 'ab-small ab-muted' },
            '逛 ' + (quota.browse || 0) + '/' + (limits.maxRunsPerDay || 0) +
            ' · 赞 ' + (quota.like || 0) + '/' + (limits.likeDaily || 0) +
            ' · 评 ' + (quota.comment || 0) + '/' + (limits.commentDaily || 0) +
            ' · 帖 ' + (quota.post || 0) + '/' + (limits.maxPostsPerDay || 0)),
          h(Btn, { small: true, kind: 'ghost', onClick: act('/heybox/clear-quota', 'quota') }, busy === 'quota' ? '清零中…' : '清零')))
        : null,
    ),
    h(Card, {
      title: '热榜预览', right: h('div', { className: 'ab-flex' },
        h(Btn, { small: true, onClick: load }, '刷新'),
        h(Btn, { small: true, kind: 'primary', onClick: loadHot, disabled: !!busy }, busy === 'hot' ? '拉取中…' : '看热榜')),
      desc: '她写帖前会先看这个（热榜 → 搜社区 → 找具体素材）。这里只是让你看看现在有什么题，热榜里电竞和商业新闻不适合这个号。',
    },
      !hot ? h(Empty, { icon: '🔥', text: '点右上角「看热榜」，看看现在小黑盒在热议什么。' })
        : (hot.list || []).length === 0 ? h(Empty, { icon: '🔥', text: '热榜是空的，可能接口变了。' })
        : h('div', { className: 'ab-list' }, (hot.list || []).map((x, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, String(i + 1)), h('div', { className: 'body' }, x.text, x.tag ? h('span', { className: 'ab-muted' }, '  [' + x.tag + ']') : null)))),
    ),
    h(Card, {
      title: '发帖自检（她发之前自己过一遍）',
      desc: '这几条写在她的规则里，不满足就不发。你也可以照着看，她要发的帖哪条对不上就让改。',
    },
      h('div', { className: 'ab-note', style: { marginBottom: 8, whiteSpace: 'pre-line' } },
        [
          '① 先看热榜挑题（不许跳过），挑不出来就说今天没合适的，别硬凑。',
          '② 再看社区高赞帖在聊什么角度，可以借角度但用自己的话。',
          '③ 素材里必须有具体的东西：价格、销量、时长、机制名、star 增速——没具体信息就是水文。',
          '④ 标题别和正文第一行重复；不编造第一人称经历；正文 200-800 字；配图越多越好。',
          '⑤ 不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话（转折词堆砌就是 AI 腔）。',
        ].join('\n')),
      h('div', { className: 'ab-note warn' },
        '格式上的坑（已修在内核里）：帖子类型必须是「文章」(link_tag=11) 才能解析 HTML 并把图插在文字中间；分区 id 必须是真实存在的 7214 / 18745 / 806933，乱填会一直报「错误的帖子类型」。'),
    ),
    h(Card, {
      title: '她逛过什么', right: h('div', { className: 'ab-flex' },
        h(Btn, { small: true, onClick: load }, '刷新'),
        h(Btn, { small: true, kind: 'primary', onClick: act('/heybox/run', 'run'), disabled: !!busy }, busy === 'run' ? '正在逛…' : '现在逛一圈')),
    },
      s && s.lastSkipReason ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '上次没逛成：' + s.lastSkipReason) : null,
      s ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } },
        s.lastRun ? '上次逛：' + timeAgo(s.lastRun) : '还没逛过') : null,
      !s ? h(Empty, { icon: '⏳', text: '加载中…' })
        : (s.history || []).length === 0 ? h(Empty, { icon: '📭', text: '还没逛过。先填 Cookie、打开开关，再点「现在逛一圈」。' })
        : h('div', { className: 'ab-list' }, (s.history || []).map((x, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, timeAgo(x.at), h('br'), HEYBOX_KIND[x.kind] || x.kind),
          h('div', { className: 'body' },
            x.linkId ? h('a', { href: 'https://www.xiaoheihe.cn/app/bbs/link/' + x.linkId, target: '_blank', rel: 'noreferrer' }, x.title || x.linkId) : null,
            x.text ? h('div', { className: 'ab-muted' }, x.text) : null,
            x.count ? h('div', { className: 'ab-muted' }, '看了 ' + x.count + ' 条') : null)))),
    ),
  )
}

/** 「内容解析」页（移植自 astrbot_plugin_multi_parser）：B站/微博/小红书/知乎/微信/贴吧等链接自动解析，支持发图文视频与AI会话注入 */
/** 资讯池：主体内容由 rss 模块的 panel.js 自动 embed 到本 tab 下面，
 *  这里只放总开关（不开这个 tab 也要能进来打开它）。 */

export { Heybox, HEYBOX_KIND }
