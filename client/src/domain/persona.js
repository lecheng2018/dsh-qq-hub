import { API } from '../core/api-base.js'
import { post } from '../core/http.js'

function planPersonaRow ({ map, id, raw }) {
  const digits = String(raw || '').replace(/\D/g, '')
  const m = map || {}
  const keep = m[id] === undefined ? '' : m[id]
  if (!digits) return { action: 'clear' }
  if (digits === id) return { action: 'keep' }
  // 目标行已被占用（且不是本行）→ 不顶掉别人，本行留成占位
  if (m[digits] !== undefined && digits !== id) return { action: 'clear' }
  return { action: 'move', key: digits, value: keep }
}
/**
 * 接口前缀：跟着「页面被挂载在哪」走，而不是写死根路径。
 *
 * 以前写的是 `'/qq-hub/api'`，在直连端口（http://127.0.0.1:13080/）时没问题，
 * 但只要 DSH 被挂在子路径下就会掉出去 —— 飞牛 App 就是这种：网关把整个 DSH
 * 挂在 `/app/Harness/dsh/`，页面里还注入了 `<base href="./">`，dsh 自己的客户端
 * 全用相对路径（`open-in-app/apps` 这种去首斜杠的写法）才走得通。写死根路径时
 * 请求打到门户根（http://<nas>:5666/qq-hub/api/state），拿到的是飞牛自己的
 * 404 HTML，`r.json()` 解析失败，iOS/Safari 只会抛一句
 * “The string did not match the expected pattern.”，看起来像是插件没装上。
 *
 * 所以从 document.baseURI 取挂载目录拼绝对路径（和浏览器解析相对路径用的是同一份
 * 基准）：站点根 → `/qq-hub/api`（行为完全不变）；子路径挂载 → `/app/Harness/dsh/qq-hub/api`。
 *
 * @param {string} href 一般是 document.baseURI
 * @returns {string} 形如 `/qq-hub/api` 或 `/app/Harness/dsh/qq-hub/api`
 */


async function pickAvatar(toast, reload) {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = 'image/png,image/jpeg,image/gif,image/webp'
  const file = await new Promise((res) => { inp.onchange = () => res(inp.files && inp.files[0]); inp.click() })
  if (!file) return
  if (file.size > 5 * 1024 * 1024) return toast('图片太大了，最多 5MB', 'err')
  const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file) })
  const r = await post('/avatar/upload', { data })
  toast(r.message, r.ok ? 'ok' : 'err')
  reload()
}
const avatarSrc = (st) => API + '/avatar?v=' + ((st.avatar && st.avatar.at) || 0)



const PSEC_HEAD = /^【([^】\n]{1,30})】\s*$/
const PSEC_SUGGEST = ['你的样子', '性格', '打字习惯', '情绪是活的', '你的生活', '和主人的关系', '绝对禁止']
// 每节一个颜色（跟着这一节走，挪位置颜色不变）。低饱和的雾色系，相邻的冷暖交替，深浅两种主题下都不刺眼：
// 青瓷、雾紫、琥珀、雾蓝、藕粉、苔绿、黛蓝、赭石、橄榄、紫藤
const PSEC_COLORS = ['#4f9a8c', '#8a7bc0', '#c08a4a', '#5f8fc7', '#c47a90', '#6f9f68', '#5c6fae', '#b9775a', '#8d9450', '#a173b5']
let psecSeq = 0
const psec = (title, text) => ({ k: ++psecSeq, title, text })
const splitPersona = (body) => {
  const out = [psec(null, '')]
  let cur = out[0]
  let buf = []
  const flush = () => { cur.text = buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''); buf = [] }
  for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    // 复制粘贴来的人设常带看不见的零宽字符（行首一个 U+200B），认标题时不算它
    const m = PSEC_HEAD.exec(line.replace(/[​-‍﻿]/g, '').trim())
    if (m) { flush(); cur = psec(m[1].trim(), ''); out.push(cur) } else buf.push(line)
  }
  flush()
  return out
}
const joinPersona = (secs) => secs
  .map((s) => (s.title === null ? s.text.trim() : '【' + (s.title.trim() || '未命名') + '】\n' + s.text.replace(/\s+$/, '')))
  .filter(Boolean).join('\n\n')
const autoRows = (text) => Math.min(22, Math.max(3, String(text || '').split('\n').length + 1))

/** 一节设定：标题、正文、上下移、删除、AI 润色。润色后原版和润色版只显示一个，按钮来回切，选定一个另一个就丢掉。 */

export {
  planPersonaRow, pickAvatar, avatarSrc,
  PSEC_HEAD, PSEC_SUGGEST, PSEC_COLORS, psec, splitPersona, joinPersona, autoRows
}
