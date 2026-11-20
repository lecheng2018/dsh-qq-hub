import { useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Range } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, pitchNum, pitchText, pitchLabel, cx } from '../core/utils.js'
import { get, post } from '../core/http.js'

function Voice({ st, draft, setDraft, toast, reload }) {
  const f = useField(draft, setDraft)
  const [txt, setTxt] = useState('晚安啦，今天也辛苦了，明天见～')
  const [src, setSrc] = useState('')
  return (
    <div className="ab-grid">
      <Card
        title="说话（文字转语音）" right={f.sw('voice.enabled')}
        desc="回复里写了 <voice>…</voice> 的部分会变成 QQ 语音条；对方明确要语音时一定发语音；短回复也有一定概率整条变语音。"
      >
        <div style={{ margin: '4px 0 12px' }}>
          {f.choices('voice.engine', [
            { value: 'auto', label: '自动', desc: 'edge-tts 优先，不行用 Windows 语音' },
            { value: 'edge', label: '微软 edge-tts', desc: st.voice.edgeInstalled ? '在线，音色自然（已装好）' : '在线，音色自然（还没装）' },
            { value: 'cosyvoice', label: '本地 CosyVoice', desc: '自己部署的 CosyVoice 服务，可克隆音色' },
            { value: 'gptsovits', label: '本地 GPT-SoVITS', desc: 'GPT-SoVITS api_v2，用参考音频定音色' },
            { value: 'doubao', label: '豆包语音 2.0', desc: '火山引擎豆包 TTS，支持声音复刻 2.0 与自动配语气' },
            { value: 'qwentts', label: '阿里百炼 qwen-tts', desc: 'DashScope 语音合成，支持语气指令与长文本分段' },
            { value: 'mimo', label: '小米 MiMo TTS', desc: '参考音频零训练克隆音色' },
            { value: 'http', label: '其他 HTTP 接口', desc: '任意返回音频的地址' },
            { value: 'windows', label: 'Windows 自带', desc: '离线可用，机械感重一些' },
          ])}
        </div>
        {['auto', 'edge'].includes(draft.voice.engine) ? (
          <Fragment>
            {!st.voice.edgeInstalled ? (
              <Row label="edge-tts" hint="装在插件自己的 Python 环境里，不影响系统">
                <Btn small onClick={async () => { toast('正在安装，可能要一两分钟…'); const r = await post('/voice/install'); toast(r.message); reload() }}>安装 edge-tts</Btn>
              </Row>
            ) : null}
            <Row label="音色">
              {f.select('voice.voice', [
                { value: 'zh-CN-XiaoyiNeural', label: '晓伊', desc: '活泼女声', group: '普通话' },
                { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓', desc: '温柔女声', group: '普通话' },
                { value: 'zh-CN-YunxiNeural', label: '云希', desc: '少年男声', group: '普通话' },
                { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', desc: '东北女声', group: '方言' },
                { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', desc: '陕西女声', group: '方言' },
                { value: 'zh-TW-HsiaoChenNeural', label: '曉臻', desc: '台湾女声', group: '方言' },
              ], { width: 220 })}
            </Row>
            <Row label="语速">
              {f.select('voice.rate', [
                { value: '-20%', label: '慢一点' },
                { value: '-10%', label: '稍慢' },
                { value: '+0%', label: '正常' },
                { value: '+10%', label: '稍快' },
                { value: '+20%', label: '快一点' },
              ], { width: 140 })}
            </Row>
            <Row label="音调" hint="±80Hz 为上限（再往上 edge-tts 服务端会静默夹住）；只对 edge-tts 有效">
              <Range
                min={-80} max={80} step={10}
                value={pitchNum(draft.voice.pitch)}
                fmt={pitchLabel}
                onChange={(v) => setDraft(setPath(draft, 'voice.pitch', pitchText(v)))}
              />
            </Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'cosyvoice' ? (
          <Fragment>
            <Row label="服务地址" hint="CosyVoice 自带 runtime/python/fastapi/server.py">{f.text('voice.cosyvoice.url', { size: 'wide', placeholder: 'http://127.0.0.1:50000' })}</Row>
            <Row label="模式">{f.select('voice.cosyvoice.mode', [{ value: 'sft', label: '预置音色（sft）' }, { value: 'instruct', label: '带语气指令（instruct）' }], { width: 220 })}</Row>
            <Row label="音色 ID" hint="例如 中文女、中文男">{f.text('voice.cosyvoice.spkId')}</Row>
            {draft.voice.cosyvoice.mode === 'instruct' ? <Row label="语气指令" hint="例如：用甜美撒娇的语气说">{f.text('voice.cosyvoice.instruct', { size: 'wide' })}</Row> : null}
            <Row label="采样率" hint="CosyVoice 1 是 22050，CosyVoice 2 是 24000">{f.select('voice.cosyvoice.sampleRate', [{ value: 22050, label: '22050 Hz' }, { value: 24000, label: '24000 Hz' }], { width: 160 })}</Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'gptsovits' ? (
          <Fragment>
            <Row label="服务地址" hint="GPT-SoVITS 的 api_v2.py">{f.text('voice.gptsovits.url', { size: 'wide', placeholder: 'http://127.0.0.1:9880' })}</Row>
            <Row label="参考音频路径" hint="服务那台电脑上的路径">{f.text('voice.gptsovits.refAudio', { size: 'wide' })}</Row>
            <Row label="参考音频的文字">{f.text('voice.gptsovits.promptText', { size: 'wide' })}</Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'doubao' ? (
          <Fragment>
            <Row label="API Key" hint="火山引擎「豆包语音」控制台创建，请求头 X-Api-Key；只存本机，不会显示出来">{f.text('voice.doubao.apiKey', { type: 'password', placeholder: draft.voice.doubao.apiKeySet ? '已保存（不改就留空）' : '还没有填' })}</Row>
            <Row label="资源 ID" hint="复刻音色只能用 seed-icl-2.0，用错会报 55000000">{f.select('voice.doubao.resourceId', [{ value: 'seed-icl-2.0', label: '声音复刻 2.0' }, { value: 'seed-tts-2.0', label: '预置音色 2.0' }], { width: 200 })}</Row>
            <Row label="音色 Speaker" hint="复刻音色 ID；预置 2.0 音色以 _uranus_bigtts 结尾">{f.text('voice.doubao.speaker', { size: 'wide', placeholder: 'S_1CmxEOek2' })}</Row>
            <Row label="固定语气指令" hint="一行一条，例如「用温柔、放慢一点的语气说这句话」；留空不加">{f.area('voice.doubao.contextTexts', { rows: 3 })}</Row>
            <Row label="按文字自动配语气" hint="按关键词自动追加语气指令（开心/生气/撒娇…），不参与计费">{f.sw('voice.doubao.autoEmotion')}</Row>
            <Row label="语速" hint="-50~100，默认 0；觉得快就调 -10 到 -20">{f.text('voice.doubao.speechRate', { size: 'narrow' })}</Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'qwentts' ? (
          <Fragment>
            <Row label="API Key" hint="阿里云百炼（DashScope）创建；只存本机，不会显示出来">{f.text('voice.qwentts.apiKey', { type: 'password', placeholder: draft.voice.qwentts.apiKeySet ? '已保存（不改就留空）' : 'sk-…' })}</Row>
            <Row label="接口地址" hint="只填到域名，路径自动拼">{f.text('voice.qwentts.baseUrl', { size: 'wide', placeholder: 'https://dashscope.aliyuncs.com' })}</Row>
            <Row label="模型" hint="百炼语音模型名">{f.text('voice.qwentts.model', { placeholder: 'qwen-audio-3.1-tts-flash' })}</Row>
            <Row label="音色" hint="官方中文女声兜底是 Cherry">{f.text('voice.qwentts.voice', { placeholder: 'Cherry' })}</Row>
            <Row label="语气基底" hint="每次合成都带上；正文里的【撒娇】【吐槽】等标记会转成临时语气指令">{f.area('voice.qwentts.instruction', { rows: 2 })}</Row>
            <Row label="分段上限" hint="长文本按句末标点切成不超过这个字数的分段，逐段合成后拼成一条">{f.text('voice.qwentts.maxCharsPerSegment', { size: 'narrow' })}</Row>
            <Row label="采样率">{f.select('voice.qwentts.sampleRate', [{ value: 24000, label: '24000 Hz' }, { value: 22050, label: '22050 Hz' }, { value: 16000, label: '16000 Hz' }], { width: 160 })}</Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'mimo' ? (
          <Fragment>
            <Row label="API Key" hint="小米 MiMo 开放平台创建，sk- 开头；只存本机，不会显示出来">{f.text('voice.mimo.apiKey', { type: 'password', placeholder: draft.voice.mimo.apiKeySet ? '已保存（不改就留空）' : 'sk-…' })}</Row>
            <Row label="API 地址" hint="一般不用改，要以 /v1 结尾">{f.text('voice.mimo.apiBase', { size: 'wide', placeholder: 'https://api.xiaomimimo.com/v1' })}</Row>
            <Row label="模型" hint="voiceclone 用参考音频克隆；voicedesign 用下面的风格描述">{f.text('voice.mimo.model', { placeholder: 'mimo-v2.5-tts-voiceclone' })}</Row>
            <Row label="参考音频路径" hint="这台电脑上的一段 mp3/wav（几秒到几十秒都行）；voicedesign 模型不需要">{f.text('voice.mimo.refAudio', { size: 'wide' })}</Row>
            <Row label="风格描述" hint="例如：元气一点的少女音，语速稍快">{f.text('voice.mimo.stylePrompt', { size: 'wide' })}</Row>
            <Row label="种子文本" hint="参考音频里说的那句话（复刻模型可选，能更像）">{f.text('voice.mimo.seedText', { size: 'wide' })}</Row>
            <Row label="超时（秒）" hint="MiMo 生成较慢，默认 180">{f.text('voice.mimo.timeout', { size: 'narrow' })}</Row>
          </Fragment>
        ) : null}
        {draft.voice.engine === 'http' ? (
          <Fragment>
            <Row label="请求方式" hint="GET 把 {text} 拼进地址；POST 配请求头和请求体（可接火山豆包等云 TTS）">
              {f.select('voice.http.method', [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }], { width: 120 })}
              <Btn small onClick={() => {
                // 豆包（火山引擎）TTS 预设：填好模板，把 APPID_HERE / TOKEN_HERE / VOICE_TYPE_HERE 换成自己的
                let d = setPath(draft, 'voice.http.urlTemplate', 'https://openspeech.bytedance.com/api/v1/tts')
                d = setPath(d, 'voice.http.method', 'POST')
                d = setPath(d, 'voice.http.headers', 'Authorization: Bearer;TOKEN_HERE')
                d = setPath(d, 'voice.http.body', '{"app":{"appid":"APPID_HERE","token":"TOKEN_HERE","cluster":"volcano_tts"},"user":{"uid":"dsh-qq-hub"},"audio":{"voice_type":"VOICE_TYPE_HERE","encoding":"mp3","speed_ratio":1.0},"request":{"reqid":"{reqid}","text":"{text}","operation":"query"}}')
                setDraft(d)
                toast('已填入豆包模板：把 APPID_HERE / TOKEN_HERE / VOICE_TYPE_HERE 换成你在火山引擎开通的值，保存后试听')
              }}>豆包预设</Btn>
            </Row>
            <Row label="地址模板" hint={draft.voice.http.method === 'POST' ? 'POST 时 {text} 放请求体里；返回音频或含 base64 音频的 JSON' : '{text} 会换成要念的话，返回 wav/mp3'}>{f.text('voice.http.urlTemplate', { size: 'wide', placeholder: 'http://127.0.0.1:8000/tts?text={text}' })}</Row>
            {draft.voice.http.method === 'POST' ? (
              <Fragment>
                <Row label="请求头" hint="一行一个 Key: Value，# 开头是注释；不填 Content-Type 自动按 JSON">{f.area('voice.http.headers', { rows: 3, placeholder: 'Authorization: Bearer;你的token' })}</Row>
                <Row label="请求体" hint="{text} 自动 JSON 转义；{text_raw} 不转义（表单用）；{reqid} 每次换新 UUID">{f.area('voice.http.body', { rows: 5, placeholder: '{"request":{"reqid":"{reqid}","text":"{text}"}}' })}</Row>
              </Fragment>
            ) : null}
          </Fragment>
        ) : null}
        <Row label="短回复变语音的概率">{f.percent('voice.autoChance')}</Row>
        <Row label="多短算短回复">{f.range('voice.autoMaxChars', 10, 200, 5, (v) => v + ' 字')}</Row>
        <Row label="试听" hint="先保存设置再试听">
          <input className="ab-input" value={txt} onChange={(e) => setTxt(e.target.value)} />
          <Btn small onClick={async () => { const r = await post('/voice/test', { text: txt }); if (r.ok) setSrc('data:' + r.mime + ';base64,' + r.data); else toast(r.message) }}>生成</Btn>
          {src ? <audio src={src} controls autoPlay style={{ height: 32 }} /> : null}
        </Row>
      </Card>
      <Card
        title="听语音（语音转文字）" right={f.sw('voice.asr')}
        desc="别人发来的语音会先转成文字再交给她：优先用 QQ 自带的转文字，不行再用 DSH 自带的语音识别（要在 DSH「插件」里开启「语音输入」）。"
      >
        <AsrStatus toast={toast} />
      </Card>
    </div>
  )
}

function AsrStatus({ toast }) {
  const [s, setS] = useState(null)
  const load = () => get('/voice/asr-status').then(setS)
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])
  const phase = s && s.enabled ? ({ ready: '已就绪', standby: '已就绪（休眠中）', idle: '还没下载模型', preparing: '正在下载模型…', downloading: '正在下载模型…', failed: '下载失败' }[s.phase] || s.phase) : null
  const ready = s && s.enabled && ['ready', 'standby'].includes(s.phase)
  return (
    <div className="ab-flex">
      <span className={cx('ab-pill', ready ? 'ok' : s && s.enabled ? 'warn' : '')}>
        <i className={cx('ab-dot', ready ? 'ok' : s && s.enabled ? 'warn' : '')} />
        {s === null ? '查询中…' : s.enabled ? 'DSH 识别：' + phase : 'DSH 识别：没开启（DSH「插件」→「语音输入」）'}
      </span>
      {s && s.enabled && !ready ? <Btn small onClick={async () => { const r = await post('/voice/asr-prepare'); toast(r.message); load() }}>下载识别模型</Btn> : null}
      {ready ? <Btn small onClick={async () => { toast('正在测试…'); const r = await post('/voice/asr-test', { text: '今天想吃白米饭' }); toast(r.ok ? '念的是「' + r.said + '」，听成了「' + r.heard + '」' : r.message) }}>测试一下</Btn> : null}
    </div>
  )
}

export { Voice, AsrStatus }
