import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInboundAudio } from '../src/chat/inbound-audio.js'
import { buildWav } from '../src/voice/wav.js'

const log = { debug() {}, warn() {} }
const record = { type: 'record', data: { file: 'voice.silk' } }

function dshFixture(calls) {
  return {
    get(name) {
      if (name !== 'speechToText') return null
      return {
        snapshot: () => ({ selection: { providerId: 'local' }, providers: [{ id: 'local', preparation: { phase: 'ready' } }] }),
        resolve: ({ audio }) => ({ bytes: audio.length }),
        transcribe: async (spec) => {
          calls.push(['dsh', spec.bytes])
          return { text: '本地模型也听见了' }
        },
      }
    },
  }
}

test('旧消息入口与模块化水合共用本地 ASR、网关和 DSH 的降级顺序', async () => {
  const calls = []
  const audio = createInboundAudio({
    log,
    localApi: null,
    dsh: dshFixture(calls),
    onebot: {
      async call(action) {
        calls.push([action])
        if (action === 'fetch_ptt_text') throw new Error('网关不可用')
        if (action === 'get_record') return { base64: buildWav([0, 1, -1], 16000).toString('base64') }
        throw new Error(`意外调用 ${action}`)
      },
    },
  })
  assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[语音] 本地模型也听见了')
  const member = Object.freeze({ messageId: 'm2', segments: Object.freeze([record]) })
  const hydrated = await audio.hydrateRecords([member])
  assert.equal(hydrated[0].segments[0].data.text, '[语音] 本地模型也听见了')
  assert.equal(member.segments[0].type, 'record', '冻结的输入不被原地修改')
  assert.deepEqual(calls.map((call) => call[0]), ['fetch_ptt_text', 'get_record', 'dsh', 'fetch_ptt_text', 'get_record', 'dsh'])
})

test('所有识别路径失败时保留诚实的语音占位', async () => {
  const audio = createInboundAudio({
    log,
    localApi: null,
    dsh: { get: () => null },
    onebot: { call: async () => { throw new Error('不可用') } },
  })
  assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[发来一条语音，没听清]')
  const [member] = await audio.hydrateRecords([{ messageId: 'm1', segments: [record] }])
  assert.equal(member.segments[0], record)
})

test('本地 ASR 优先于网关，转换后的临时 WAV 在调用后清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-inbound-audio-'))
  const calls = []
  let wav = ''
  const audio = createInboundAudio({
    log,
    dsh: { get: () => null },
    localApi: {
      active: (name) => name === 'asr',
      dir: () => dir,
      call: async (name, { file }) => {
        calls.push(name)
        wav = file
        assert.equal(existsSync(file), true)
        return { text: '本地接口先听见' }
      },
    },
    onebot: {
      call: async (action) => {
        calls.push(action)
        if (action === 'get_record') return { base64: buildWav([0, 1, -1], 8000).toString('base64') }
        throw new Error('本地成功后不应继续调用网关')
      },
    },
  })
  assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[语音] 本地接口先听见')
  assert.deepEqual(calls, ['get_record', 'asr'])
  assert.equal(existsSync(wav), false)
})
