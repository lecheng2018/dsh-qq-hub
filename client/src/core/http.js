import { API } from './api-base.js'

const readJson = (r) => r.text().then((text) => {
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object') return data
  } catch (e) { /* 不是 JSON，落到下面拼错误消息 */ }
  const snippet = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
  return { ok: false, status: r.status, message: 'HTTP ' + r.status + '：' + (snippet || '空响应') }
})
const failed = (e) => ({ ok: false, message: '连不上插件：' + (e && e.message ? e.message : e) + '（接口 ' + API + '）' })
const get = (p) => fetch(API + p, { cache: 'no-store' }).then(readJson).catch(failed)
const post = (p, body) =>
  fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(readJson)
    .catch(failed)

export { readJson, failed, get, post }
