// 移植自 h-D-ACE/dsh-qq 的 totp.js + mode-control.js：权限锁（Security Lock）
//
// dsh-qq 的 L0~L3 权限阶梯 + RFC 6238 TOTP 二次认证：
// - 默认低权限，要提权必须主人在私聊里输入一次性验证码 + 手机动态口令
// - 提权后有存活时间（dsh-qq 是 30 分钟），超时自动降回低权限
// - AI 自己无法提权，只能"申请"；审批消息根本不进模型上下文，免疫提示词注入
//
// aurabot 里权限由 access.js 的 level（full / social / chat）决定，
// 这个模块不改 access.js，而是叠加一层「时间锁」：
// 1. 主人私聊默认也算「上锁」状态（比 full 更保守，可配置成默认不上锁）
// 2. 主人发 /unlock 得到一次性码 → 用手机 Authenticator 算 6 位 TOTP → /unlock 码 TOTP
// 3. 解锁后 full 权限只在 expireMinutes 内有效，超时自动锁上
// 4. 每次提权 / 降权 / 拒绝都记审计日志（面板「日志」页可看）
//
// TOTP 实现与 dsh-qq 一致：纯 node:crypto，HMAC-SHA1，30 秒步长，6 位数字，防时间步重放。

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { readJson, writeJson } from '../../core/store.js'
import { dataDir } from '../../core/store.js'

const ID = 'security-lock'
const STEP = 30 // 秒
const DIGITS = 6
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 生成一个新的 base32 密钥（默认 20 字节，和 Google Authenticator 一样）。 */
export function newSecret(bytes = 20) {
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) buf[i] = randomInt(0, 256)
  let bits = ''
  for (const b of buf) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  const rest = bits.length % 5
  if (rest) out += B32[parseInt(bits.slice(bits.length - rest).padEnd(5, '0'), 2)]
  return out
}

/** base32 → Buffer。 */
export function base32Decode(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = ''
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) continue
    bits += i.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** 某个时间步的 TOTP（RFC 6238 / HOTP RFC 4226）。 */
export function totpAt(secret, counter) {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter % 0x100000000, 4)
  const h = createHmac('sha1', key).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 10 ** DIGITS
  return String(code).padStart(DIGITS, '0')
}

/**
 * 校验 TOTP。window=1 表示允许前后各一个时间步（时钟偏差容错），
 * 返回命中的时间步（用于防重放），失败返回 0。
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\D/g, '')
  if (c.length !== DIGITS) return 0
  const step = Math.floor(now / 1000 / STEP)
  for (let d = -window; d <= window; d++) {
    const got = totpAt(secret, step + d)
    // 定长比较，别让计时差泄露
    if (timingSafeEqual(Buffer.from(got), Buffer.from(c))) return step + d
  }
  return 0
}

/** otpauth:// 链接，手机验证器扫码用（二维码由面板画）。 */
export function otpauthUrl(secret, account = 'aurabot') {
  const label = encodeURIComponent(`Aurabot:${account}`)
  const params = new URLSearchParams({ secret, issuer: 'Aurabot', algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP) })
  return `otpauth://totp/${label}?${params.toString()}`
}

export default {
  id: ID,
  name: '权限锁',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：主人私聊提权要过手机上的一次性口令，超时自动锁回去',
  panel: 'panel.js',
  tab: 'access',
  defaults: {
    enabled: false,
    /** 每次解锁的存活分钟数（dsh-qq 是 30） */
    expireMinutes: 30,
    /** 默认就锁着：主人私聊也得解锁才能用完整工具 */
    lockByDefault: true,
    /** 解锁成功后多少秒内必须用掉一次性码 */
    codeTtlSeconds: 180,
  },
  settings: [
    { key: 'enabled', label: '启用权限锁', type: 'switch', hint: '关着的时候和原来完全一样（主人私聊直接是完整权限）' },
    { key: 'expireMinutes', label: '解锁后有效多久（分钟）', type: 'number', min: 1, max: 1440, step: 1, hint: 'dsh-qq 用 30 分钟：超时自动锁回去' },
    { key: 'lockByDefault', label: '默认锁着', type: 'switch', hint: '开着：主人私聊也要 /unlock 才能用完整工具' },
    { key: 'codeTtlSeconds', label: '一次性码有效期（秒）', type: 'number', min: 30, max: 900, step: 30 },
  ],
  setup(api) {
    const stateFile = () => dataDir('state.json')
    // { secret, unlockedUntil, usedSteps: [], pending: { code, at } }
    let st = readJson(stateFile(), { secret: '', unlockedUntil: 0, usedSteps: [], pending: null })
    const save = () => { try { writeJson(stateFile(), st) } catch (error) { api.log.warn('保存权限锁状态失败：', error.message) } }
    if (!st.secret) { st.secret = newSecret(); save() }

    const audit = (action, note = '') => {
      api.log.info(`[权限锁] ${action}${note ? '：' + note : ''}`)
      api.emit('security-lock/audit', { action, note, at: Date.now() })
    }

    const locked = () => {
      const cfg = api.settings()
      if (!cfg.enabled) return false
      if (!cfg.lockByDefault) return false
      return Number(st.unlockedUntil || 0) < Date.now()
    }
    const remainingMin = () => Math.max(0, Math.ceil((Number(st.unlockedUntil || 0) - Date.now()) / 60000))

    function makePending() {
      const cfg = api.settings()
      const code = String(randomInt(100000, 1000000))
      st.pending = { code, at: Date.now(), ttl: Number(cfg.codeTtlSeconds) * 1000 }
      save()
      return code
    }

    // ---- 主人命令 ----
    api.command({
      name: 'unlock',
      desc: '申请解锁完整权限：/unlock 拿验证码，再 /unlock 验证码+口令',
      aliases: ['解锁', '提权'],
      run: async (arg, msg) => {
        const cfg = api.settings()
        if (!cfg.enabled) return '权限锁没开（面板「权限」页可以打开）'
        if (msg.kind !== 'private') return '解锁要在私聊里做'
        if (!api.isOwner(msg.userId)) return '只有主人能解锁'
        const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
        if (!parts.length) {
          const code = makePending()
          audit('申请解锁', `验证码 ${code}`)
          return `好，${Math.round(Number(cfg.codeTtlSeconds) / 60)} 分钟内把下面这串发给我，中间空一格、后面接手机上那个 6 位口令：\n${code} <手机口令>`
        }
        const [code, totp] = parts
        if (Number(st.unlockedUntil || 0) > Date.now()) return `本来就是解锁状态，还剩 ${remainingMin()} 分钟`
        const p = st.pending
        if (!p) return '没有待确认的解锁请求，先发 /unlock'
        if (Date.now() - Number(p.at) > Number(p.ttl)) { st.pending = null; save(); audit('解锁失败', '验证码过期'); return '验证码过期了，重新发 /unlock' }
        if (String(code) !== String(p.code)) { audit('解锁失败', '验证码不对'); return '验证码不对，重新发 /unlock' }
        if (st.usedSteps.includes(0)) st.usedSteps = []
        const hitStep = verifyTotp(st.secret, totp, { window: 1 })
        if (!hitStep) { audit('解锁失败', '口令不对'); return '口令不对（看看手机上还剩几秒，过期了等一下新的）' }
        if ((st.usedSteps || []).includes(hitStep)) { audit('解锁失败', '时间步已被用过'); return '这个口令用过了，等手机上刷新出来的下一个' }
        st.usedSteps = [...(st.usedSteps || []), hitStep].slice(-10)
        st.pending = null
        st.unlockedUntil = Date.now() + Number(cfg.expireMinutes) * 60_000
        save()
        audit('解锁成功', `${cfg.expireMinutes} 分钟`)
        return `好了，${cfg.expireMinutes} 分钟内是完整权限，到时间我会自己锁上`
      },
    })

    api.command({
      name: 'lock',
      desc: '马上锁回低权限',
      aliases: ['上锁', '降权'],
      run: async (arg, msg) => {
        if (!api.isOwner(msg.userId)) return '只有主人能操作'
        st.unlockedUntil = 0
        save()
        audit('手动上锁')
        return '锁上了'
      },
    })

    api.command({
      name: 'lockstatus',
      desc: '看权限锁状态',
      aliases: ['权限状态'],
      run: async (arg, msg) => {
        const cfg = api.settings()
        if (!cfg.enabled) return '权限锁没开'
        const left = remainingMin()
        return `默认${cfg.lockByDefault ? '锁着' : '开着'}，现在${left ? `解锁中，还剩 ${left} 分钟` : '是锁着的'}`
      },
    })

    // ---- 定时兜底：到点自动锁（重启后也能恢复） ----
    const timer = setInterval(() => {
      if (st.unlockedUntil && Number(st.unlockedUntil) < Date.now()) {
        st.unlockedUntil = 0
        save()
        audit('超时自动上锁')
      }
    }, 30_000)
    timer.unref?.()
    api.onDispose(() => clearInterval(timer))

    // ---- 面板接口 ----
    api.route('/status', () => ({
      ok: true,
      enabled: api.settings().enabled,
      locked: locked(),
      remainingMin: remainingMin(),
      hasSecret: Boolean(st.secret),
      otpauth: st.secret ? otpauthUrl(st.secret, String(api.config()?.ownerQQ || 'aurabot')) : '',
    }))
    // 面板要的：otpauth 链接 + 密钥本体（面板画成二维码，主机下拉就能扫码）
    api.route('/otpauth', () => ({
      ok: true,
      secret: st.secret,
      otpauth: otpauthUrl(st.secret, String(api.config()?.ownerQQ || 'aurabot')),
      account: String(api.config()?.ownerQQ || 'aurabot'),
    }))
    api.route('/reset-secret', () => {
      st.secret = newSecret()
      st.unlockedUntil = 0
      st.usedSteps = []
      st.pending = null
      save()
      audit('重置密钥', '旧的口令全部作废')
      return { ok: true, otpauth: otpauthUrl(st.secret, String(api.config()?.ownerQQ || 'aurabot')) }
    })

    return {
      locked,
      remainingMin,
      totpAt,
      verifyTotp,
      otpauthUrl,
      secret: () => st.secret,
      state: () => ({ ...st, pending: st.pending ? { at: st.pending.at } : null }),
    }
  },
}
