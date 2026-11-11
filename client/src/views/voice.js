import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Range, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, pitchNum, pitchText, pitchLabel, cx } from '../core/utils.js'
import { get, post, failed } from '../core/http.js'
import { modOn } from '../domain/nav.js'

function Voice({ st, draft, setDraft, toast, reload }) {
  const f = useField(draft, setDraft)
  const [txt, setTxt] = useState('晚安啦，今天也辛苦了，明天见～')
  const [src, setSrc] = useState('')
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '说话（文字转语音）', right: f.sw('voice.enabled'), desc: '回复里写了 <voice>…</voice> 的部分会变成 QQ 语音条；对方明确要语音时一定发语音；短回复也有一定概率整条变语音。' },
      h('div', { style: { margin: '4px 0 12px' } }, f.choices('voice.engine', [
        { value: 'auto', label: '自动', desc: 'edge-tts 优先，不行用 Windows 语音' },
        { value: 'edge', label: '微软 edge-tts', desc: st.voice.edgeInstalled ? '在线，音色自然（已装好）' : '在线，音色自然（还没装）' },
        { value: 'cosyvoice', label: '本地 CosyVoice', desc: '自己部署的 CosyVoice 服务，可克隆音色' },
        { value: 'gptsovits', label: '本地 GPT-SoVITS', desc: 'GPT-SoVITS api_v2，用参考音频定音色' },
        { value: 'http', label: '其他 HTTP 接口', desc: '任意返回音频的地址' },
        { value: 'windows', label: 'Windows 自带', desc: '离线可用，机械感重一些' },
      ])),
      ['auto', 'edge'].includes(draft.voice.engine) ? [
        !st.voice.edgeInstalled ? h(Row, { key: 'i', label: 'edge-tts', hint: '装在插件自己的 Python 环境里，不影响系统' }, h(Btn, { small: true, onClick: async () => { toast('正在安装，可能要一两分钟…'); const r = await post('/voice/install'); toast(r.message); reload() } }, '安装 edge-tts')) : null,
        h(Row, { key: 'v', label: '音色' }, f.select('voice.voice', [
          { value: 'zh-CN-XiaoyiNeural', label: '晓伊', desc: '活泼女声', group: '普通话' }, { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓', desc: '温柔女声', group: '普通话' },
          { value: 'zh-CN-YunxiNeural', label: '云希', desc: '少年男声', group: '普通话' },
          { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', desc: '东北女声', group: '方言' }, { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', desc: '陕西女声', group: '方言' },
          { value: 'zh-TW-HsiaoChenNeural', label: '曉臻', desc: '台湾女声', group: '方言' }], { width: 220 })),
        h(Row, { key: 'r', label: '语速' }, f.select('voice.rate', [{ value: '-20%', label: '慢一点' }, { value: '-10%', label: '稍慢' }, { value: '+0%', label: '正常' }, { value: '+10%', label: '稍快' }, { value: '+20%', label: '快一点' }], { width: 140 })),
        h(Row, { key: 'p', label: '音调', hint: '拖动调整，±80Hz 为上限（实测再往上 edge-tts 会静默夹住）；只对 edge-tts 有效' },
          h(Range, {
            min: -80,
            max: 80,
            step: 10,
            value: pitchNum(draft.voice.pitch),
            fmt: pitchLabel,
            onChange: (v) => setDraft(setPath(draft, 'voice.pitch', pitchText(v))),
          })),
      ] : null,
      draft.voice.engine === 'cosyvoice' ? [
        h(Row, { key: 'u', label: '服务地址', hint: 'CosyVoice 自带 runtime/python/fastapi/server.py' }, f.text('voice.cosyvoice.url', { size: 'wide', placeholder: 'http://127.0.0.1:50000' })),
        h(Row, { key: 'm', label: '模式' }, f.select('voice.cosyvoice.mode', [{ value: 'sft', label: '预置音色（sft）' }, { value: 'instruct', label: '带语气指令（instruct）' }], { width: 220 })),
        h(Row, { key: 's', label: '音色 ID', hint: '例如 中文女、中文男' }, f.text('voice.cosyvoice.spkId')),
        draft.voice.cosyvoice.mode === 'instruct' ? h(Row, { key: 'i', label: '语气指令', hint: '例如：用甜美撒娇的语气说' }, f.text('voice.cosyvoice.instruct', { size: 'wide' })) : null,
        h(Row, { key: 'r', label: '采样率', hint: 'CosyVoice 1 是 22050，CosyVoice 2 是 24000' }, f.select('voice.cosyvoice.sampleRate', [{ value: 22050, label: '22050 Hz' }, { value: 24000, label: '24000 Hz' }], { width: 160 })),
      ] : null,
      draft.voice.engine === 'gptsovits' ? [
        h(Row, { key: 'u', label: '服务地址', hint: 'GPT-SoVITS 的 api_v2.py' }, f.text('voice.gptsovits.url', { size: 'wide', placeholder: 'http://127.0.0.1:9880' })),
        h(Row, { key: 'a', label: '参考音频路径', hint: '服务那台电脑上的路径' }, f.text('voice.gptsovits.refAudio', { size: 'wide' })),
        h(Row, { key: 'p', label: '参考音频的文字' }, f.text('voice.gptsovits.promptText', { size: 'wide' })),
      ] : null,
      draft.voice.engine === 'http' ? h(Row, { label: '地址模板', hint: '{text} 会换成要念的话，返回 wav/mp3' }, f.text('voice.http.urlTemplate', { size: 'wide', placeholder: 'http://127.0.0.1:8000/tts?text={text}' })) : null,
      h(Row, { label: '短回复变语音的概率' }, f.percent('voice.autoChance')),
      h(Row, { label: '多短算短回复' }, f.range('voice.autoMaxChars', 10, 200, 5, (v) => v + ' 字')),
      h(Row, { label: '试听', hint: '先保存设置再试听' },
        h('input', { className: 'ab-input', value: txt, onChange: (e) => setTxt(e.target.value) }),
        h(Btn, { small: true, onClick: async () => { const r = await post('/voice/test', { text: txt }); if (r.ok) setSrc('data:' + r.mime + ';base64,' + r.data); else toast(r.message) } }, '生成'),
        src ? h('audio', { src, controls: true, autoPlay: true, style: { height: 32 } }) : null),
    ),
    h(VoiceSongModel, { draft, setDraft }),
    h(Card, { title: '听语音（语音转文字）', right: f.sw('voice.asr'), desc: '别人发来的语音会先转成文字再交给她：优先用 QQ 自带的转文字，不行再用 DSH 自带的语音识别（要在 DSH「插件」里开启「语音输入」）。' },
      h(AsrStatus, { toast })),
  )
}

function AsrStatus({ toast }) {
  const [s, setS] = useState(null)
  const load = () => get('/voice/asr-status').then(setS)
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])
  const phase = s && s.enabled ? ({ ready: '已就绪', standby: '已就绪（休眠中）', idle: '还没下载模型', preparing: '正在下载模型…', downloading: '正在下载模型…', failed: '下载失败' }[s.phase] || s.phase) : null
  return h('div', { className: 'ab-flex' },
    h('span', { className: 'ab-pill' }, h('i', { className: cx('ab-dot', s && s.enabled && ['ready', 'standby'].includes(s.phase) ? 'ok' : s && s.enabled ? 'warn' : '') }), s === null ? '查询中…' : s.enabled ? 'DSH 识别：' + phase : 'DSH 识别：没开启（DSH「插件」→「语音输入」）'),
    s && s.enabled && !['ready', 'standby'].includes(s.phase) ? h(Btn, { small: true, onClick: async () => { const r = await post('/voice/asr-prepare'); toast(r.message); load() } }, '下载识别模型') : null,
    s && s.enabled && ['ready', 'standby'].includes(s.phase) ? h(Btn, { small: true, onClick: async () => { toast('正在测试…'); const r = await post('/voice/asr-test', { text: '今天想吃白米饭' }); toast(r.ok ? '念的是「' + r.said + '」，听成了「' + r.heard + '」' : r.message) } }, '测试一下') : null)
}


export { Voice, AsrStatus }
