// 内置模块：语音。把她的话念出来发语音条（edge-tts / Windows 语音 / CosyVoice / GPT-SoVITS / 本地接口），
// 面板里的试听、语音识别自检也在这里。
// 导出 speak(text) → { file, engine }：聊天中枢发语音时找它。替换这个模块就能换成任何你想要的念法。

import { existsSync, readFileSync } from 'node:fs'
import { characterName } from '../../persona/identity-context.js'
import { textToSpeech, edgeInstalled, installEdge } from '../../voice/tts.js'
import { toMono16k } from '../../voice/wav.js'
import { createCloudAsr } from '../../voice/cloud-asr.js'
import { fileOf } from '../../local/local.js'

export default {
  id: 'voice',
  name: '语音',
  version: '1.0.0',
  description: '发语音条：把她的话念出来（关掉后想发语音时改发文字）',
  tab: 'voice',
  files: ['voice/tts.js', 'voice/uv.js', 'voice/cloud-asr.js'],
  // 云端 ASR（1.4.4）：存 ext.voice.cloudAsr*，入站语音链路在本地接口之后尝试
  defaults: {
    cloudAsrEnabled: false,
    cloudAsrProvider: 'siliconflow',
    cloudAsrBaseUrl: '',
    cloudAsrApiKey: '',
    cloudAsrModel: 'FunAudioLLM/SenseVoiceSmall',
  },
  settings: [
    { key: 'cloudAsrEnabled', label: '云端语音识别', type: 'switch', hint: '别人发来的语音条，本地接口识别不了时用云端 ASR（硅基 SenseVoice / OpenAI 兼容 whisper）。云端失败自动落回 QQ 转文字与 DSH 本地识别。保存即生效' },
    { key: 'cloudAsrProvider', label: '云端服务商', type: 'select', options: [{ value: 'siliconflow', label: '硅基流动 SenseVoice' }, { value: 'openai', label: 'OpenAI 兼容 whisper' }], hint: '两家都是 /audio/transcriptions 协议，只是默认地址和模型不同' },
    { key: 'cloudAsrBaseUrl', label: '接口地址（base）', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', hint: '留空默认硅基流动；OpenAI 兼容服务填自己的 base（不含 /audio/transcriptions）' },
    { key: 'cloudAsrApiKey', label: 'API Key', type: 'password', hint: '保存在配置文件里（面板不回显，留空保存不会清掉已填的）' },
    { key: 'cloudAsrModel', label: '模型名', type: 'text', placeholder: 'FunAudioLLM/SenseVoiceSmall', hint: 'OpenAI 兼容 whisper 一般填 whisper-1' },
  ],
  setup(api) {
    const { hub, onebot, local, http } = api.core
    const cloudAsr = createCloudAsr({ getConfig: api.config, log: api.log })

    async function speak(text) {
      // 本地接口接管语音合成；出错退回内置
      if (local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text }))
          if (file && existsSync(file)) return { file, engine: 'local' }
        } catch (error) {}
      }
      return textToSpeech(text, api.config().voice, api.log)
    }

    api.route('/voice/test', async (req) => {
      const b = await http.body(req)
      const { file, engine } = await speak(String(b.text || `你好呀，我是${characterName('', api.config())}`))
      const buf = readFileSync(file)
      return { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') }
    })
    api.route('/voice/install', async () => installEdge(api.log))

    // DSH 自带语音识别：看状态 / 下载模型
    const stt = () => api.dsh.get('speechToText')
    api.route('/voice/asr-status', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, enabled: false, cloud: cloudAsr.status(), message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      const p = s.providers.find((x) => x.id === s.selection.providerId) || s.providers[0]
      return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation, cloud: cloudAsr.status() }
    })
    api.route('/voice/asr-prepare', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
      s0.prepare(s0.snapshot().selection.providerId)
      return { ok: true, message: '开始下载识别模型（约 200MB，下好后常驻本机）' }
    })
    // 自检「听语音」（真 QQ）：拿和某人私聊里最近一条语音，走一遍 get_record → 16k → DSH 识别
    api.route('/voice/asr-last', async (req) => {
      const b = await http.body(req)
      const uid = Number(b.userId || api.config().ownerQQ)
      const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
      const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
      const last = recs.at(-1)
      if (!last) return { ok: false, message: '最近的聊天里没有对方发的语音' }
      const t = Date.now()
      const text = await hub.localTranscribe(last.seg)
      return { ok: Boolean(text), heard: text, at: new Date(last.time * 1000).toLocaleString(), ms: Date.now() - t }
    })
    // 自检「听语音」：Windows 语音念一句 → 转 16k 单声道 → DSH 自带识别 → 看能不能认回来
    api.route('/voice/asr-test', async (req) => {
      const b = await http.body(req)
      // 云端 ASR 自检：TTS 念一句 → 16k 单声道 → 云端识别（provider=cloud 时）
      if (b.provider === 'cloud') {
        if (!cloudAsr.enabled()) return { ok: false, message: '云端 ASR 未启用：在下面语音模块设置里填 API Key 并打开开关' }
        const text = String(b.text || '今天想吃白米饭')
        const t = Date.now()
        try {
          const { file } = await textToSpeech(text, api.config().voice, api.log)
          const heard = await cloudAsr.transcribe(toMono16k(readFileSync(file)))
          return { ok: Boolean(heard), said: text, heard, engine: 'cloud', ms: Date.now() - t }
        } catch (error) {
          return { ok: false, said: text, message: String(error.message || error), ms: Date.now() - t }
        }
      }
      const s0 = stt()
      if (!s0 || typeof s0.resolve !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
      const text = String(b.text || '今天想吃白米饭')
      const { file } = await textToSpeech(text, { engine: 'windows' })
      const t = Date.now()
      const spec = s0.resolve({ audio: new Uint8Array(toMono16k(readFileSync(file))) })
      const r = await s0.transcribe(spec, AbortSignal.timeout(120000))
      const heard = typeof r === 'string' ? r : r?.text || r?.transcript || JSON.stringify(r)
      return { ok: Boolean(heard), said: text, heard, ms: Date.now() - t }
    })

    return { speak, edgeInstalled }
  },
}
