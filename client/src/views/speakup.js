import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Range, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

function SpeakUp({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '主动搭话', right: f.sw('speakUp.enabled'), desc: '只在和你的私聊里：你一阵子没理她，她会主动来找你说一句——每次由头不一样（分享小事、接着上次的话题、想起你的事、按时间问候……），内容是她现想的，不是模板。群里不会这样。' },
      h(Row, { label: '追问', hint: '她问了你一句、你 15~40 分钟没回，偶尔轻轻追一句（「人呢」之类），每句最多追一次' }, f.sw('speakUp.nudge')),
      h(Row, { label: '多久没聊才找你' }, f.num('speakUp.idleMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '分钟')),
      h(Row, { label: '两次之间隔', hint: '在这个范围里随机' }, f.num('speakUp.minIntervalMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '到'), f.num('speakUp.maxIntervalMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '分钟')),
      h(Row, { label: '每天最多' }, f.num('speakUp.maxPerDay', { min: 0 }), h('span', { className: 'ab-muted' }, '次')),
      h(Row, { label: '她醒着的时间', hint: '这段时间外不打扰你' }, f.num('speakUp.awakeFrom', { min: 0, max: 23 }), h('span', { className: 'ab-muted' }, '点到'), f.num('speakUp.awakeTo', { min: 1, max: 24 }), h('span', { className: 'ab-muted' }, '点')),
      h('div', { className: 'ab-flex', style: { marginTop: 10 } },
        h('span', { className: 'ab-muted ab-small' }, '今天已经找过你 ' + (st.speakUp.count || 0) + ' 次'),
        h('div', { className: 'ab-spacer' }),
        h(Btn, { small: true, onClick: async () => { const r = await post('/speakup/fire'); toast(r.message) } }, '现在就让她来找我')),
    ),
  )
}


export { SpeakUp }
