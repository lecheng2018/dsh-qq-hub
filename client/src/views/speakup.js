import { Fragment, h } from '../core/react.js'
import { Card, Row, Btn } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { post } from '../core/http.js'

function SpeakUp({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  return (
    <div className="ab-grid">
      <Card
        title="主动搭话" right={f.sw('speakUp.enabled')}
        desc="只在和你的私聊里：你一阵子没理她，她会主动来找你说一句——每次由头不一样（分享小事、接着上次的话题、想起你的事、按时间问候……），内容是她现想的，不是模板。群里不会这样。"
      >
        <Row label="追问" hint="她问了你一句、你 15~40 分钟没回，偶尔轻轻追一句（「人呢」之类），每句最多追一次">{f.sw('speakUp.nudge')}</Row>
        <Row label="多久没聊才找你">{f.num('speakUp.idleMinutes', { min: 5 })}<span className="ab-muted">分钟</span></Row>
        <Row label="两次之间隔" hint="在这个范围里随机">
          {f.num('speakUp.minIntervalMinutes', { min: 5 })}<span className="ab-muted">到</span>{f.num('speakUp.maxIntervalMinutes', { min: 5 })}<span className="ab-muted">分钟</span>
        </Row>
        <Row label="每天最多">{f.num('speakUp.maxPerDay', { min: 0 })}<span className="ab-muted">次</span></Row>
        <Row label="她醒着的时间" hint="这段时间外不打扰你">
          {f.num('speakUp.awakeFrom', { min: 0, max: 23 })}<span className="ab-muted">点到</span>{f.num('speakUp.awakeTo', { min: 1, max: 24 })}<span className="ab-muted">点</span>
        </Row>
        <div className="ab-flex" style={{ marginTop: 10 }}>
          <span className="ab-muted ab-small">今天已经找过你 {st.speakUp.count || 0} 次</span>
          <div className="ab-spacer" />
          <Btn small onClick={async () => { const r = await post('/speakup/fire'); toast(r.message) }}>现在就让她来找我</Btn>
        </div>
      </Card>
    </div>
  )
}

export { SpeakUp }
