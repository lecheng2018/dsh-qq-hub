import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Empty, Seg, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { API } from '../core/api-base.js'
import { setPath, timeAgo } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

function PaintGallery({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const shown = Math.min(50, Math.max(1, Number(draft.imageGen && draft.imageGen.galleryShown) || 20))
  const [data, setData] = useState(null)
  const load = async () => {
    const r = await get('/image/gallery?limit=' + shown).catch(() => null)
    setData(r && r.ok ? r : { items: [], total: 0, dir: '' })
  }
  useEffect(() => { load() }, [shown])
  const del = async (file) => {
    if (!confirm('删掉这张画？\n' + file)) return
    const r = await post('/image/gallery/delete', { file }).catch(() => ({ ok: false }))
    toast(r.message || (r.ok ? '删掉了' : '删除失败'), r.ok ? 'ok' : 'err')
    load()
  }
  return h(Card, {
    title: '她的画作' + (data ? '（显示最近 ' + data.items.length + ' 张 / 共 ' + data.total + ' 张）' : ''),
    desc: '她画过的图都存在本机（不会自动删），这里只是面板里显示多少张。想看全部或者清理，点「打开文件夹」。',
    right: h('div', { className: 'ab-flex' },
      h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新'),
      h(Btn, { small: true, kind: 'ghost', onClick: () => post('/image/open-folder').then((r) => toast(r.message, r.ok ? 'ok' : 'err')).catch(() => toast('打不开文件夹', 'err')) }, '打开文件夹')),
  },
    h(Row, { label: '面板显示最近', hint: '最多 50 张；只影响面板显示，不删文件' },
      f.num('imageGen.galleryShown', { min: 1, max: 50 }), h('span', { className: 'ab-muted' }, '张')),
    data && data.dir ? h('div', { className: 'ab-muted ab-small', style: { margin: '4px 0 8px', wordBreak: 'break-all' } }, '存图目录：' + data.dir) : null,
    !data ? h(Empty, { icon: '⏳', text: '加载中…' })
      : data.items.length === 0 ? h(Empty, { icon: '🎨', text: '她还没画过图。在聊天里说「画一张……」，画好的图会出现在这里。' })
        : h('div', { className: 'ab-shots' }, data.items.map((it) => h(PaintCell, { key: it.file, it, onDelete: () => del(it.file) }))),
  )
}

function PaintCell({ it, onDelete }) {
  const src = API + '/image/gallery/image?file=' + encodeURIComponent(it.file)
  const cap = it.prompt ? '「' + it.prompt + '」' : '画作'
  const when = it.at ? timeAgo(it.at) : ''
  return h('div', { className: 'ab-shot' },
    h('a', { href: src, target: '_blank', rel: 'noreferrer' }, h('img', { src, alt: cap, loading: 'lazy' })),
    h('div', { className: 'cap', title: cap }, cap + (when ? '　' + when : '')),
    h('button', { type: 'button', className: 'ab-btn sm danger x', title: '删除', onClick: onDelete }, '✕'),
  )
}

function CodexSub({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [status, setStatus] = useState(null)
  const [waiting, setWaiting] = useState(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = () => get('/image/codex/status').then(setStatus).catch(() => setStatus({ loggedIn: false }))
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    if (!waiting) return undefined
    let active = true
    const timer = setInterval(async () => {
      const r = await get('/image/codex/login/status').catch(() => null)
      if (!active || !r) return
      if (r.state === 'done' || r.state === 'error') {
        clearInterval(timer); setWaiting(null); setInput(''); refresh()
        toast(r.state === 'done' ? '登录成功' : r.error || '登录失败')
      }
    }, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [Boolean(waiting)])
  const act = (path, body = {}) => async () => {
    setBusy(true)
    const r = await post(path, body).catch(() => ({ ok: false, message: '请求失败' }))
    setBusy(false)
    if (!r.ok) { toast(r.message || '操作失败'); return }
    setInput('')
    if (path.endsWith('/login')) setWaiting({ url: r.url, needPaste: r.needPaste })
    else { setWaiting(null); refresh(); toast(path.endsWith('/logout') ? '已退出 ChatGPT' : path.endsWith('/cancel') ? '已取消登录' : '登录成功') }
  }
  return h('div', null,
    h('div', { className: 'ab-note', style: { margin: '8px 0' } }, '实验性订阅接法：使用非公开图片端点，可用性和额度由账号、工作区及服务端决定。登录信息仅存本机。'),
    h(Row, { label: 'ChatGPT 账号' },
      h('span', { className: 'ab-small' }, status === null ? '读取登录状态…' : status.loggedIn ? '已登录：' + (status.email || status.accountId) : '尚未登录'),
      h(Btn, { small: true, onClick: act('/image/codex/login'), disabled: busy || Boolean(waiting) }, '登录 ChatGPT'),
      status?.loggedIn ? h(Btn, { small: true, onClick: act('/image/codex/logout'), disabled: busy }, '退出') : null),
    waiting ? h('div', { className: 'ab-note' },
      h('div', null, waiting.needPaste ? '端口 1455 被占用：打开授权链接登录，再粘贴完整回调地址。' : '请在浏览器完成登录。回调成功后自动刷新，也可以手动粘贴完整回调地址。'),
      h('a', { href: waiting.url, target: '_blank', rel: 'noreferrer', style: { display: 'block', wordBreak: 'break-all' } }, '打开 ChatGPT 授权页'),
      h('input', { className: 'ab-input', value: input, type: 'password', autoComplete: 'off', placeholder: '粘贴完整回调地址', onChange: (e) => setInput(e.target.value) }),
      h(Btn, { small: true, onClick: act('/image/codex/complete', { input }), disabled: busy || !input.trim() }, '完成登录'),
      h(Btn, { small: true, onClick: act('/image/codex/cancel'), disabled: busy }, '取消登录')) : null,
    h(Row, { label: '模型', hint: '可用模型由服务端决定' }, f.select('imageGen.codex.model', [
      { value: 'gpt-image-2', label: 'gpt-image-2' }, { value: 'gpt-image-2.5-flare', label: 'gpt-image-2.5-flare' }, { value: 'gpt-image-2.5-sunburst', label: 'gpt-image-2.5-sunburst' },
    ], { width: 260 })),
    h(Row, { label: '质量', hint: '所选模型需支持该选项' }, f.select('imageGen.codex.quality', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })), { width: 180 })),
    h(Row, { label: '背景' }, f.select('imageGen.codex.background', ['auto', 'opaque', 'transparent'].map((value) => ({ value, label: value })), { width: 180 })),
    h('div', { className: 'ab-muted ab-small' }, '订阅接法通过构图提示引导，实际尺寸由服务端选择。'),
  )
}

function ImageGen({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const c = draft.imageGen
  const custom = c.custom || {}
  const isCustom = c.provider === 'custom'
  const isCodex = c.provider === 'codex'
  const isPost = custom.method === 'POST'
  const params = Array.isArray(custom.params) ? custom.params : []
  const setParams = (next) => setDraft(setPath(draft, 'imageGen.custom.params', next))
  const setP = (i, k, v) => setParams(params.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '让她画图', right: f.sw('imageGen.enabled'), desc: '接上生图服务后，让她「画一张……」就会画好发出来。可选 OpenAI 兼容接口、自定义接口，或登录 ChatGPT 使用实验性 Codex 订阅接法。本机 SD WebUI / ComfyUI 可在「本地接口」页接「生图」。' },
      h(Row, { label: '接口格式', hint: '第二个适合 pollinations 这类「GET 一个地址就出图」的服务' },
        h(Seg, {
          value: isCodex ? 'codex' : isCustom ? 'custom' : 'openai',
          onChange: (v) => setDraft(setPath(draft, 'imageGen.provider', v)),
          options: [{ value: 'openai', label: 'OpenAI 格式' }, { value: 'custom', label: '自定义接口' }, { value: 'codex', label: 'Codex 订阅（实验性）' }],
        })),
      isCodex ? h(CodexSub, { draft, setDraft, toast }) : isCustom ? h('div', null,
        h(Row, { label: '请求方式', hint: 'GET 把参数都拼在地址上；POST 放进请求体' },
          h(Seg, {
            value: isPost ? 'POST' : 'GET',
            onChange: (v) => setDraft(setPath(draft, 'imageGen.custom.method', v)),
            options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }],
          })),
        h(Row, { label: '接口地址', hint: '可以用 {prompt} {model} {size} {width} {height}' },
          f.text('imageGen.custom.url', { size: 'wide', placeholder: 'https://image.pollinations.ai/prompt/{prompt}' })),
        h(Row, { label: 'API Key', hint: '会以 Authorization: Bearer 发出；不需要就留空' },
          f.text('imageGen.apiKey', { type: 'password', placeholder: c.apiKeySet ? '已保存（不改就留空）' : '没有就留空' })),
        h('div', { className: 'ab-label', style: { marginTop: 12 } },
          h('b', null, isPost ? '请求体参数' : 'URL 参数'),
          h('small', null, '参数名和值都自己填；值里可以用 {prompt}')),
        params.length
          ? params.map((p, i) => h('div', { key: i, className: 'ab-flex', style: { gap: 6, marginBottom: 6 } },
            h('input', { className: 'ab-input', style: { width: 170 }, value: p.key || '', placeholder: '参数名，如 model', onChange: (e) => setP(i, 'key', e.target.value) }),
            h('input', { className: 'ab-input', style: { flex: 1 }, value: p.value || '', placeholder: '值，可以用 {prompt}', onChange: (e) => setP(i, 'value', e.target.value) }),
            h(Btn, { small: true, onClick: () => setParams(params.filter((_, j) => j !== i)) }, '删')))
          : h('div', { className: 'ab-muted ab-small', style: { marginBottom: 6 } }, '还没有参数 —— 比如 model=flux-anime、width=1080、height=1920、nologo=true'),
        h('div', { className: 'ab-flex', style: { marginBottom: 10 } },
          h(Btn, { small: true, onClick: () => setParams([...params, { key: '', value: '' }]) }, '＋ 加一个参数')),
        isPost ? h(Row, { label: '请求体格式' },
          h(Seg, {
            value: custom.bodyType === 'form' ? 'form' : 'json',
            onChange: (v) => setDraft(setPath(draft, 'imageGen.custom.bodyType', v)),
            options: [{ value: 'json', label: 'JSON' }, { value: 'form', label: '表单' }],
          })) : null,
        h(Row, { label: '取值路径', hint: '接口直接回图片就留空；回 JSON 时填地址字段' },
          f.text('imageGen.custom.responsePath', { size: 'wide', placeholder: '如 data.0.url（留空自动找）' })),
      ) : h('div', null,
        h(Row, { label: '服务地址', hint: '一般以 /v1 结尾' }, f.text('imageGen.baseUrl', { size: 'wide', placeholder: 'https://api.siliconflow.cn/v1' })),
        h(Row, { label: 'API Key', hint: '只存在本机，不会显示出来' }, f.text('imageGen.apiKey', { type: 'password', placeholder: c.apiKeySet ? '已保存（不改就留空）' : '没有就留空' })),
        h(Row, { label: '模型' }, f.text('imageGen.model', { size: 'wide', placeholder: '例如 Kwai-Kolors/Kolors' })),
      ),
      h(Row, { label: '默认构图', hint: isCodex ? '通过构图提示引导，实际尺寸由服务端选择，不保证严格比例' : '聊天工具可指定本次构图。服务不支持所选尺寸时会报告失败，请换一种构图；自定义接口需使用尺寸占位符' },
        f.select('imageGen.shape', [
          { value: 'her', label: '让她选择', desc: isCodex ? '未指定时由服务端选择' : '未指定时沿用图片尺寸' },
          { value: 'square', label: isCodex ? '方图 1:1' : '方图 1:1（1024 × 1024）' },
          { value: 'portrait', label: isCodex ? '竖图 2:3' : '竖图 2:3（1024 × 1536）' },
          { value: 'landscape', label: isCodex ? '横图 3:2' : '横图 3:2（1536 × 1024）' },
          { value: 'wide', label: isCodex ? '宽幅 16:9' : '宽幅 16:9（1536 × 864）' },
        ], { width: 260 })),
      !isCodex && (!c.shape || c.shape === 'her') ? h(Row, { label: '图片尺寸', hint: isCustom ? '接口地址 / 参数里可以用 {size} 或 {width}/{height}' : '未指定构图时沿用这个尺寸' },
        f.select('imageGen.size', [{ value: '1024x1024', label: '1024 × 1024', desc: '方图' }, { value: '768x1024', label: '768 × 1024', desc: '竖图' }, { value: '1024x768', label: '1024 × 768', desc: '横图' }, { value: '512x512', label: '512 × 512', desc: '小图，更快' }], { width: 200 })) : null,
      h(Row, { label: '固定风格', hint: '每次画都会加在描述前面' }, f.text('imageGen.stylePrompt', { size: 'wide', placeholder: '例如：日系二次元，柔和光线，蓝白配色' })),
      h(Row, { label: '只给主人画', hint: '关掉后群友也能让她画（会花你的额度）' }, f.sw('imageGen.ownerOnly')),
      h(Row, { label: '让她画完自己看一眼', hint: '开着才把画好的图传给她看（模型不支持看图时自动不传）；关掉就只回一句「画好了」，不传图' }, f.sw('imageGen.seeOwn')),
      isCustom ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, '例子：地址填 https://image.pollinations.ai/prompt/{prompt}，再加 model=flux-anime、width=1080、height=1920、nologo=true 四个参数，GET 就会请求 …/prompt/<提示词>?model=flux-anime&width=1080&…') : null,
      !c.enabled ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, '还没开启。填好接口信息、打开右上角开关并保存后，她就会多一个「画图」能力。') : null,
    ),
    h(PaintGallery, { draft, setDraft, toast }),
  )
}


export { ImageGen, PaintGallery, PaintCell, CodexSub }
