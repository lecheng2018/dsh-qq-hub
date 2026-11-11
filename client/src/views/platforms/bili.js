import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../../core/react.js'
import { Card, Row, Btn, Switch, Range, Empty, ModOff } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'
import { API } from '../../core/api-base.js'
import { setPath, timeAgo } from '../../core/utils.js'
import { get, post } from '../../core/http.js'

function BiliCookie({ draft, setDraft }) {
  const [show, setShow] = useState(false)
  const b = draft.bili
  const field = (key, prefix, setKey, hintKey, ph) => h('div', { className: 'ab-flex', style: { flexWrap: 'nowrap', marginBottom: 6 } },
    h('code', { className: 'ab-small', style: { minWidth: 82, textAlign: 'right' } }, prefix),
    h('input', {
      className: 'ab-input wide', type: show ? 'text' : 'password', autoComplete: 'off', spellCheck: false, value: b[key] || '',
      placeholder: b[setKey] ? '已保存（结尾 ' + (b[hintKey] || '…') + '），不改就留空' : ph,
      onChange: (e) => setDraft(setPath(draft, 'bili.' + key, e.target.value.trim())),
    }))
  return h(Row, { label: 'B 站 Cookie', hint: '电脑浏览器登录 bilibili.com → F12 → 「应用」（Application）→ Cookie → bilibili.com，分别复制 SESSDATA 和 bili_jct 这两行的「值」。也可以直接粘整串 Cookie，会自动拆开。只存在本机；不填也能看视频，但看不到 AI 字幕、不能评论和回复。建议用小号' },
    h('div', { style: { flex: 1 } },
      field('sessdata', 'SESSDATA=', 'sessdataSet', 'sessdataHint', '粘贴 SESSDATA 的值'),
      field('biliJct', 'bili_jct=', 'biliJctSet', 'biliJctHint', '粘贴 bili_jct 的值'),
      h('div', { className: 'ab-flex' },
        h(Btn, { small: true, onClick: () => setShow(!show) }, show ? '隐藏' : '显示'),
        b.sessdataSet || b.biliJctSet ? h(Btn, { small: true, kind: 'ghost', onClick: () => { if (confirm('清空保存的 B 站 Cookie？')) setDraft(setPath(setPath(setPath(draft, 'bili.sessdata', null), 'bili.biliJct', null), 'bili.cookie', null)) } }, '清空') : null,
        h('span', { className: 'ab-muted ab-small' }, '「显示」看的是正在填的内容；保存过的出于安全不回传，只显示结尾几位'))))
}

/** 本地接口：数据目录 local/ 里的脚本接管语音合成、生图、翻唱换声、语音识别。 */


const BILI_KIND = { watch: '看了', comment: '评论', reply: '回复', share: '分享给你', shot: '发你截图', error: '没成功' }

/** B 站：登录、定时刷、评论 / 回复、分享给主人，以及她刷过什么。 */
function Bili({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState('')
  const [shots, setShots] = useState(null)
  const load = () => get('/bili/state').then(setS).catch((e) => toast(e.message, 'err'))
  const loadShots = () => get('/bili/shots').then((r) => setShots(r.items || [])).catch((e) => { setShots([]); toast(e.message, 'err') })
  useEffect(() => { load(); loadShots() }, [])
  const act = (path, label) => async () => { setBusy(label); const r = await post(path); setBusy(''); toast(r.message, r.ok ? 'ok' : 'err'); load(); loadShots() }
  const acct = s && s.account
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '刷 B 站', right: f.sw('bili.enabled'), desc: '她会定时去 B 站刷几个视频：从她的兴趣、记忆里你喜欢的东西和下面的关键词里挑方向去搜，读简介、字幕和热评，再按自己的性格决定评不评论、要不要私聊分享给你、记住什么。看过的、评过的都记成她的经历，聊天时会自然提起。你在 QQ 里发 B 站链接或分享卡片，她也能点进去看完再聊。' },
      h(BiliCookie, { draft, setDraft }),
      h('div', { className: 'ab-flex', style: { marginTop: 4 } },
        h(Btn, { small: true, onClick: async () => { const r = await get('/bili/account'); setS({ ...(s || {}), account: r }) } }, '检查登录'),
        acct ? h('span', { className: 'ab-small', style: { color: acct.isLogin ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, acct.isLogin ? '已登录：' + acct.uname : '没登录（只能看，不能评论）') : null),
    ),
    h(Card, { title: '怎么刷', desc: '只在「主动搭话」里设的醒着时间内刷。' },
      h(Row, { label: '定时自己去刷' }, f.sw('bili.autoBrowse')),
      h(Row, { label: '多久刷一轮' }, f.range('bili.intervalHours', 1, 24, 1, (v) => v + ' 小时')),
      h(Row, { label: '每天最多刷' }, f.range('bili.maxRunsPerDay', 0, 12, 1, (v) => v + ' 轮')),
      h(Row, { label: '一轮看几个视频' }, f.range('bili.perRun', 1, 6, 1, (v) => v + ' 个')),
      h(Row, { label: '额外想看的方向', hint: '一行一个；另外还会参考她的兴趣和记忆' }, f.list('bili.keywords', { placeholder: '白米饭 做法\n猫咪\n游戏解说' })),
      h(Row, { label: '播放量门槛' }, f.num('bili.minViews', { min: 0 }), h('span', { className: 'ab-muted' }, '次以上')),
      h(Row, { label: '只看最近' }, f.num('bili.maxAgeDays', { min: 0 }), h('span', { className: 'ab-muted' }, '天内发的（0 = 不限）')),
    ),
    h(Card, { title: '看画面（抽帧 + 视觉）', desc: '默认只读标题、简介、字幕和热评。打开后用 ffmpeg 抽帧交给视觉模型，截图保存到本机，可以在 QQ 聊天里让她挑一张发送。没有 ffmpeg、模型明确不支持图片或处理失败时，自动继续文字阅读。' },
      h(Row, { label: '让她看画面', hint: '需要视觉模型 + ffmpeg；关掉就退回只看文字' }, f.sw('bili.vision')),
      h(Row, { label: '每个视频抽几帧' }, f.range('bili.visionFrames', 2, 12, 1, (v) => v + ' 帧')),
      h(Row, { label: '刷完顺手发张截图', hint: '概率；跟发一张表情包一样默认 35%，0 = 从不。截图都存在本机，你让她发她也能挑' }, f.range('bili.shotChance', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
      h(Row, { label: '截图库最多存', hint: '超过就自动删最旧的；下面的截图库里也能一张张手动删' }, f.num('bili.shotLibrary', { min: 20, max: 2000 }), h('span', { className: 'ab-muted' }, '张')),
      h(Row, { label: 'ffmpeg 路径', hint: '留空就自己在 PATH 里找；找不到就填绝对路径' }, f.text('bili.ffmpegPath', { placeholder: 'C:\\ffmpeg\\bin\\ffmpeg.exe' })),
      s && s.vision ? h('div', { className: 'ab-small', style: { marginTop: 4, color: s.vision.ffmpeg ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, (s.vision.ffmpeg ? '✓ 已找到 ffmpeg：' + s.vision.ffmpeg : '✗ 没找到 ffmpeg：抽帧会被跳过，装一个或者在上面填路径') + (s.shots ? '　·　手上存了 ' + s.shots.count + ' 张截图' : '')) : null,
    ),
    h(Card, { title: '截图库' + (shots ? '（' + shots.length + ' / ' + ((draft.bili && draft.bili.shotLibrary) || 300) + '）' : ''), right: h('div', { className: 'ab-flex' },
      h(Btn, { small: true, kind: 'ghost', onClick: loadShots }, '刷新')) },
      !shots ? h(Empty, { icon: '⏳', text: '加载中…' }) : shots.length === 0 ? h(Empty, { icon: '🎬', text: '还没有截图。打开上面的「让她看画面」刷一轮 B 站，就会开始截。' }) :
        h('div', { className: 'ab-shots' }, shots.map((it) => h(ShotCell, { key: it.file, it, onChanged: () => { loadShots(); load() }, toast }))),
    ),
    h(Card, { title: '评论、回复和分享', desc: '评论和回复要登录。试运行开着时只记日志不发。' },
      h(Row, { label: '自己发评论' }, f.sw('bili.comment'), h('span', { className: 'ab-muted' }, '每天最多'), f.num('bili.maxCommentsPerDay', { min: 0, max: 50 }), h('span', { className: 'ab-muted' }, '条')),
      h(Row, { label: '回别人回她的评论' }, f.sw('bili.reply'), h('span', { className: 'ab-muted' }, '每天最多'), f.num('bili.maxRepliesPerDay', { min: 0, max: 100 }), h('span', { className: 'ab-muted' }, '条')),
      h(Row, { label: '看到好玩的分享给你', hint: '私聊发给主人，带视频链接' }, f.sw('bili.shareToOwner')),
      h(Row, { label: '顺手点赞' }, f.sw('bili.like')),
    ),
    h(Card, { title: '她刷过什么', right: h('div', { className: 'ab-flex' },
      h(Btn, { small: true, onClick: act('/bili/replies', 'replies'), disabled: !!busy }, busy === 'replies' ? '正在看…' : '看看有没有人回她'),
      h(Btn, { small: true, kind: 'primary', onClick: act('/bili/run', 'run'), disabled: !!busy }, busy === 'run' ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在刷…') : '现在刷一轮')) },
      s && s.pauseReason ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '今天先不发评论和回复了：' + s.pauseReason + '（明天自动恢复；Cookie 过期的话重新复制一份填上）') : null,
      s ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } }, '今天自动刷了 ' + s.runs + ' 轮 · 评论 ' + s.comments + ' 条 · 回复 ' + s.replies + ' 条' + (s.lastRun ? ' · 上次 ' + timeAgo(s.lastRun) : '') + '（手动刷不占次数）') : null,
      !s ? h(Empty, { icon: '⏳', text: '加载中…' }) : s.history.length === 0 ? h(Empty, { icon: '📺', text: '还没刷过。点「现在刷一轮」试试。' }) :
        h('div', { className: 'ab-list' }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, timeAgo(x.at), h('br'), BILI_KIND[x.kind] || x.kind),
          h('div', { className: 'body' }, x.bvid ? h('a', { href: 'https://www.bilibili.com/video/' + x.bvid, target: '_blank', rel: 'noreferrer' }, '《' + x.title + '》') : h('b', null, '《' + x.title + '》'), x.text ? h('div', { className: 'ab-muted' }, x.text) : null)))),
    ),
  )
}

function ShotCell({ it, onChanged, toast }) {
  const src = API + '/bili/shot/image?file=' + encodeURIComponent(it.file)
  const cap = (it.title ? '《' + it.title + '》' : '截图') + (it.clock ? '　' + it.clock : '')
  return h('div', { className: 'ab-shot' },
    h('a', { href: src, target: '_blank', rel: 'noreferrer' }, h('img', { src, alt: cap, loading: 'lazy' })),
    h('div', { className: 'cap', title: it.note || '' }, cap),
    h('button', {
      type: 'button',
      className: 'ab-btn sm danger x',
      title: '删除',
      onClick: async () => {
        if (!confirm('删掉这张截图？\n' + cap)) return
        const r = await post('/bili/shot/delete', { file: it.file })
        toast(r.message || '删掉了', r.ok ? 'ok' : 'err')
        onChanged()
      },
    }, '✕'),
  )
}


export { Bili, BiliCookie, ShotCell, BILI_KIND }
