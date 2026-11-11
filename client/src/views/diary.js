import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, ListArea, ListInput, Empty, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, timeAgo } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

const AUDIENCE_OPTIONS = [
  { value: 'all', label: '所有人可见' },
  { value: 'friends', label: '好友可见' },
  { value: 'selected', label: '部分好友可见' },
  { value: 'excluded', label: '部分好友不可见' },
  { value: 'self', label: '仅自己可见' },
]
const AUDIENCE_LABEL = Object.fromEntries(AUDIENCE_OPTIONS.map((o) => [o.value, o.label]))

/** 可见范围：固定范围存进配置；部分好友再配一份 QQ 名单。 */
function DiaryAudience({ draft, setDraft, toast }) {
  const mode = draft.diary.visibility
  const partial = mode === 'selected' || mode === 'excluded'
  const [friends, setFriends] = useState(null)
  const [query, setQuery] = useState('')
  const qqText = draft.diary.audienceQQs || ''
  const selected = Array.from(new Set(String(qqText).split(/[\s,，;；]+/).filter(Boolean)))
  const setList = (list) => setDraft(setPath(draft, 'diary.audienceQQs', Array.from(new Set(list)).join('\n')))
  const toggle = (qq) => setList(selected.includes(qq) ? selected.filter((q) => q !== qq) : [...selected, qq])
  return h('div', null,
    h(Row, { label: '谁能看', hint: '和 QQ 空间的可见范围一致' },
      h(Select, { value: mode, options: AUDIENCE_OPTIONS, width: 170, onChange: (v) => setDraft(setPath(draft, 'diary.visibility', v)) })),
    partial ? h('div', { style: { marginTop: 10 } },
      h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 8 } },
        h(Btn, { small: true, kind: 'ghost', onClick: async () => { try { const r = await get('/diary/friends'); if (!r.ok) return toast(r.message || '读取好友失败'); setFriends(r.friends) } catch (e) { toast(e.message) } } }, '从好友列表选择'),
        h('span', { className: 'ab-muted ab-small' }, '已选 ' + selected.length + ' 人，只对之后发的说说生效')),
      friends ? h('div', { style: { marginBottom: 8 } },
        h('input', { className: 'ab-input', placeholder: '搜索昵称或 QQ 号', value: query, onChange: (e) => setQuery(e.target.value) }),
        h('div', { style: { maxHeight: 220, overflow: 'auto', marginTop: 6 } },
          friends.filter((f) => (f.name + f.qq).toLowerCase().includes(query.toLowerCase())).map((f) =>
            h('label', { key: f.qq, style: { display: 'block', padding: '4px 2px' } },
              h('input', { type: 'checkbox', checked: selected.includes(f.qq), onChange: () => toggle(f.qq) }),
              ' ' + (f.name || '（无备注）') + '（' + f.qq + '）')))) : null,
      h('textarea', {
        className: 'ab-textarea', style: { minHeight: 64 }, placeholder: '也可以直接填 QQ 号，一行一个',
        value: qqText, onChange: (e) => setDraft(setPath(draft, 'diary.audienceQQs', e.target.value)),
      }),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, mode === 'selected' ? '名单为空时不会发布，也不会退回公开。' : '这些好友看不到之后的说说。')) : null,
  )
}

function Diary({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [data, setData] = useState(null)
  const on = modOn(st, 'diary')
  const load = () => (on ? get('/diary/history').then((r) => { setData(r); if (r.warning) toast(r.warning) }).catch((e) => toast('日记状态刷新失败：' + e.message)) : null)
  useEffect(() => { load() }, [on])
  const social = modOn(st, 'qzone-social') ? h(QzoneSocial, { draft, setDraft, toast }) : h(ModOff, { name: '空间互动' })
  if (!on) return h('div', { className: 'ab-grid' }, h(ModOff, { name: '空间日记' }), social)
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '空间日记', right: f.sw('diary.enabled'), desc: '她每天会在 QQ 空间发几条说说，结合当天聊过的事，用自己的口吻写。写日记那一轮不会发到聊天里。' },
      h(Row, { label: '每天写几次' }, f.num('diary.timesPerDay', { min: 0, max: 6 })),
      h(Row, { label: '时间段', hint: '在这段时间里随机挑时间' }, f.text('diary.windowStart', { size: 'sm' }), h('span', { className: 'ab-muted' }, '到'), f.text('diary.windowEnd', { size: 'sm' })),
      h(Row, { label: '两篇至少隔' }, f.num('diary.minGapMinutes', { min: 0 }), h('span', { className: 'ab-muted' }, '分钟')),
      h(Row, { label: '字数' }, f.num('diary.minChars', { min: 10 }), h('span', { className: 'ab-muted' }, '到'), f.num('diary.maxChars', { min: 20 }), h('span', { className: 'ab-muted' }, '字')),
      h(Row, { label: '日记配图', hint: '开着时每篇会从「今天她画的图 / 今天收的表情包」里挑一张配上去；没有合适的就只发文字' }, f.sw('diary.attachImage')),
      h(DiaryAudience, { draft, setDraft, toast }),
    ),
    h(Card, { title: '写过的日记', right: h('div', { className: 'ab-flex' },
      data && data.next ? h('span', { className: 'ab-muted ab-small' }, '下一篇大约 ' + data.next) : null,
      h(Btn, { small: true, kind: 'ghost', title: '刷新空间状态', onClick: load }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('path', { d: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17' }))),
      h(Btn, { small: true, kind: 'primary', onClick: async () => { toast('她在写了…'); try { const r = await post('/diary/run', {}); toast(r.ok ? (r.dryRun ? '写好了（试运行，没真发）' : '发出去了') : r.message) } catch (e) { toast(e.message) } finally { await load() } } }, '现在写一篇')) },
      !data ? h(Empty, { icon: '⏳', text: '加载中…' }) : !data.items || data.items.length === 0 ? h(Empty, { icon: '📔', text: '还没写过日记。' }) :
        h('div', { className: 'ab-list' }, data.items.map((d, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, new Date(d.at).toLocaleString(), h('br'), d.deletedAt ? '已从空间删除' : d.dryRun ? '试运行' : d.ok ? (AUDIENCE_LABEL[d.visibility] || '已发布') : '失败'),
          h('div', { className: 'body' }, d.text, d.error ? h('div', { className: 'ab-small', style: { color: 'var(--ab-err)' } }, d.error) : null),
          d.tid && !d.deletedAt ? h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('从 QQ 空间删除这条说说？')) return; try { const r = await post('/qzone/delete', { tid: d.tid }); toast(r.message) } catch (e) { toast(e.message) } finally { await load() } } }, '从空间删除') : null))),
    ),
    social,
  )
}

const SOCIAL_KIND = { reply: '回复评论', comment: '评论', like: '点赞' }

/** 空间互动：回复自己说说下的评论、逛好友动态。 */
function QzoneSocial({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [s, setS] = useState(null)
  const load = () => get('/qzone/social/state').then(setS)
  useEffect(() => { load() }, [])
  return h(Card, { title: '空间互动', right: f.sw('qzoneSocial.enabled'), desc: '她会定期逛 QQ 空间：有人评论她的说说就回一句；刷到好友的说说，偶尔点个赞、评一句（你的说说她更爱评）。评论按她的人格现写；试运行时只记日志不发。' },
    h(Row, { label: '回复自己说说下的评论' }, f.sw('qzoneSocial.replyOwn')),
    h(Row, { label: '评论好友的说说' }, f.sw('qzoneSocial.commentFriends')),
    h(Row, { label: '顺手点赞' }, f.sw('qzoneSocial.like')),
    h(Row, { label: '好友说说互动概率', hint: '每条说说只判断一次' }, f.percent('qzoneSocial.friendChance')),
    h(Row, { label: '你的说说互动概率' }, f.percent('qzoneSocial.ownerChance')),
    h(Row, { label: '每天最多评论', hint: '点赞不算' }, f.range('qzoneSocial.maxPerDay', 0, 30, 1, (v) => v + ' 条')),
    h(Row, { label: '多久逛一次', hint: '只在「主动搭话」里设的醒着时间内' }, f.range('qzoneSocial.intervalMin', 10, 240, 10, (v) => v + ' 分钟')),
    h('div', { className: 'ab-flex', style: { marginTop: 10 } },
      h('span', { className: 'ab-muted ab-small' }, s ? '今天评论了 ' + s.count + ' 条' + (s.lastRun ? '，上次逛是 ' + timeAgo(s.lastRun) : '') : ''),
      h('div', { className: 'ab-spacer' }),
      h(Btn, { small: true, onClick: async () => { toast('她去逛空间了…'); const r = await post('/qzone/social/run'); toast(r.message, r.ok ? 'ok' : 'err'); load() } }, '现在逛一次')),
    s && s.history && s.history.length ? h('div', { className: 'ab-list', style: { marginTop: 10 } }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
      h('div', { className: 'meta' }, timeAgo(x.at), h('br'), SOCIAL_KIND[x.kind] || x.kind),
      h('div', { className: 'body' }, h('b', null, x.who), x.post ? h('span', { className: 'ab-muted' }, ' 的「' + x.post + '」') : null, x.text ? h('div', null, x.text) : null)))) : null,
  )
}


export { Diary, DiaryAudience, QzoneSocial, AUDIENCE_OPTIONS, AUDIENCE_LABEL, SOCIAL_KIND }
