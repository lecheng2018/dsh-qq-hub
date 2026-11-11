import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Range, Empty, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { API } from '../core/api-base.js'
import { clone, setPath, getPath, timeAgo, copy, cx } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

function VoiceImport({ s, toast, onChange }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState('')
  const upload = async (files) => {
    for (const file of [...files]) {
      if (!/\.(zip|pth|index|ckpt)$/i.test(file.name)) { toast('「' + file.name + '」不是 .zip / .pth / .index / .ckpt', 'err'); continue }
      setBusy('正在导入「' + file.name + '」（' + Math.round(file.size / 1024 / 1024) + 'MB）…')
      const r = await fetch(API + '/song/import?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
        .then((x) => x.json()).catch((e) => ({ ok: false, message: '上传失败：' + e.message }))
      toast(r.message, r.ok ? 'ok' : 'err')
    }
    setBusy('')
    onChange()
  }
  const pick = () => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.multiple = true
    inp.accept = '.zip,.pth,.index,.ckpt'
    inp.onchange = () => inp.files && upload(inp.files)
    inp.click()
  }
  return h(Card, { title: '音色模型', desc: '插件不自带音色。把你有权使用的 RVC 模型导进来：.pth（可以带 .index），或者装着它们的 zip。只存在本机。自己训练的是 so-vits-svc 之类别的模型、或者想用自己的推理参数？去「本地接口」页接「翻唱换声」。' },
    h('div', {
      className: 'ab-drop' + (over ? ' over' : ''), role: 'button', tabIndex: 0,
      onClick: pick, onKeyDown: (e) => (e.key === 'Enter' || e.key === ' ') && pick(),
      onDragOver: (e) => { e.preventDefault(); setOver(true) }, onDragLeave: () => setOver(false),
      onDrop: (e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files) },
    }, busy ? h('span', null, h('i', { className: 'ab-spin' }), ' ' + busy) : h('span', null, '把 .zip / .pth / .index 拖到这里，或者点击选择文件')),
    // 分离模型自动下载不动时：给几个地址，用浏览器或下载工具下好，拖进上面这个框
    s.parts && !s.parts.separatorModel && (s.separatorLinks || []).length ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
      h('b', null, '人声分离模型下不动？'), ' 安装时会自动试好几个源（断了能接着下，太慢会换源）。实在不行，用浏览器或下载工具下好下面任一个（约 640 MB，是同一个文件），拖进上面这个框就行，插件会核对文件对不对：',
      (s.separatorLinks || []).map((u) => h('div', { key: u, className: 'ab-flex', style: { marginTop: 4 } },
        h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, u),
        h(Btn, { small: true, kind: 'ghost', onClick: () => { navigator.clipboard.writeText(u); toast('复制了', 'ok') } }, '复制')))) : null,
    s.voices.length && !s.enabled ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } }, '音色导入好了，但翻唱开关还没开（这一页最上面），打开并保存后她才会唱。') : null,
    s.voices.length === 0 ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '还没有音色。') :
      h('div', { className: 'ab-list', style: { marginTop: 10 } }, s.voices.map((v) => h('div', { key: v.id, className: 'ab-li' },
        h('div', { className: 'body' }, h('b', null, v.id), v.hasIndex ? h('span', { className: 'ab-muted ab-small' }, ' · 带 index') : null),
        h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('删掉音色「' + v.id + '」？')) return; const r = await post('/song/voice/delete', { id: v.id }); toast(r.message, r.ok ? 'ok' : 'err'); onChange() } }, '删除')))))
}

const fmtBytes = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB')
const fmtDur = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒' }

/** 装到哪里：列出每个盘和剩余空间，点一下选；也可以自己填路径。 */
function RootPicker({ draft, setDraft, s }) {
  const val = draft.song.root || ''
  const cur = val || s.defaultRoot
  const [drives, setDrives] = useState([])
  const [chk, setChk] = useState(null)
  useEffect(() => { get('/song/drives').then((r) => setDrives(r.list || [])) }, [])
  useEffect(() => {
    const t = setTimeout(() => get('/song/root/check?path=' + encodeURIComponent(cur)).then(setChk), 300)
    return () => clearTimeout(t)
  }, [cur])
  const pick = (root) => setDraft(setPath(draft, 'song.root', root === s.defaultRoot ? '' : root))
  return h('div', { style: { width: '100%' } },
    h('div', { className: 'ab-drives' },
      h('button', { type: 'button', className: cx('ab-drive', !val && 'on'), onClick: () => pick(s.defaultRoot) }, h('b', null, '默认位置'), h('small', null, s.defaultRoot)),
      drives.map((d) => h('button', { key: d.drive, type: 'button', className: cx('ab-drive', val.toLowerCase() === d.root.toLowerCase() && 'on', d.freeGB < 10 && 'low'), onClick: () => pick(d.root) },
        h('b', null, d.drive + ' 盘'), h('small', null, '剩 ' + d.freeGB + ' GB / 共 ' + Math.round(d.totalGB) + ' GB'),
        h('span', { className: 'bar' }, h('i', { style: { width: Math.round((1 - d.freeGB / d.totalGB) * 100) + '%' } }))))),
    h('input', { className: 'ab-input wide', style: { marginTop: 8 }, value: val, placeholder: '或者自己填路径，留空 = 默认位置（' + s.defaultRoot + '）', onChange: (e) => setDraft(setPath(draft, 'song.root', e.target.value)) }),
    chk ? h('div', { className: 'ab-small', style: { marginTop: 4, color: !chk.ok || chk.warn ? 'var(--ab-warn)' : 'var(--ab-sub)' } },
      !chk.ok ? chk.message : ['装在 ' + cur, chk.freeGB !== null ? '这个盘还剩 ' + chk.freeGB + ' GB' : '', chk.warn].filter(Boolean).join('；')) : null,
    val && val !== s.root && s.voices.length ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 2 } }, '换位置后，已导入的音色要重新导入（或把原来的 models 文件夹搬过去）') : null)
}

/** 安装进度：步骤条 + 当前这一步的用时、预计、下载量和网速，一看就知道没卡住。 */
function InstallProgress({ inst }) {
  const pr = inst.progress
  const now = Date.now()
  const steps = inst.steps || []
  return h('div', { className: 'ab-install' },
    h('div', { className: 'ab-install-steps' }, steps.map((name, i) => h('div', { key: i, className: cx('st', i < inst.stepIndex && 'done', i === inst.stepIndex && 'on'), title: name },
      h('i', null, i < inst.stepIndex ? '✓' : i + 1), h('span', null, name.replace(/（.*?）/g, ''))))),
    h('div', { className: 'ab-flex', style: { marginTop: 12 } }, h('i', { className: 'ab-spin' }), h('b', null, '第 ' + (inst.stepIndex + 1) + ' / ' + steps.length + ' 步：' + inst.step), h('div', { className: 'ab-spacer' }),
      h('span', { className: 'ab-muted ab-small' }, '这一步 ' + fmtDur(now - inst.stepAt) + ' · 总共 ' + fmtDur(now - inst.startedAt))),
    inst.stepHint ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 2 } }, '预计：' + inst.stepHint) : null,
    pr && pr.kind === 'download' ? h('div', { className: 'ab-install-dl' },
      h('div', null, h('small', null, '已下载'), h('b', null, fmtBytes(pr.done))),
      h('div', null, h('small', null, '当前网速'), h('b', { style: { color: pr.speed < 20 * 1024 ? 'var(--ab-warn)' : undefined } }, fmtBytes(pr.speed) + '/s')),
      pr.speed < 20 * 1024 ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)', flex: '1 1 220px' } }, '很慢的话：打开「用国内镜像下载」后重新点安装（已下好的不会重下），或者开着代理') : null) : null,
    pr && pr.kind === 'file' && pr.total ? h('div', { style: { marginTop: 10 } },
      h('div', { className: 'ab-flex ab-small' }, h('span', null, pr.name), h('div', { className: 'ab-spacer' }), h('span', null, fmtBytes(pr.done) + ' / ' + fmtBytes(pr.total) + '（' + Math.round((pr.done / pr.total) * 100) + '%）')),
      h('div', { className: 'ab-mood', style: { marginTop: 4 } }, h('i', { style: { width: Math.round((pr.done / pr.total) * 100) + '%' } }))) : null)
}

const SONG_PARTS = [['python', 'Python 环境'], ['applio', 'Applio（RVC 推理引擎）'], ['separator', '人声分离'], ['ffmpeg', 'ffmpeg（混音）'], ['weights', '预训练文件（音高、音色特征）'], ['separatorModel', '人声分离模型']]

function Song({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [s, setS] = useState(st.song)
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const [pitch, setPitch] = useState(0)
  const [acct, setAcct] = useState(null)
  const load = () => get('/song/status').then((r) => r.ok && setS(r))
  // 安装中 / 正在唱的时候每 3 秒刷新一次进度
  useEffect(() => {
    load()
    const busy = s && (s.install.running || s.current || s.queue.length)
    if (!busy) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [s && s.install.running, s && Boolean(s.current), s && s.queue.length])
  if (!s) return h(Empty, { icon: '⏳', text: '加载中…' })
  const search = async () => { if (!q.trim()) return; setFound(null); const r = await get('/song/search?q=' + encodeURIComponent(q)); setFound(r.list || []); if (!r.ok) toast(r.message, 'err') }
  const sing = async (song) => { const r = await post('/song/request', { songId: song.id, song: song.name, pitch }); toast(r.message, r.ok ? 'ok' : 'err'); load() }
  const voices = s.voices.map((v) => ({ value: v.id, label: v.id, desc: v.hasIndex ? '带 .index' : '' }))
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '翻唱', right: f.sw('song.enabled'), desc: '让她用自己的声音唱歌：点歌 → 从网易云下载 → 分离人声和伴奏 → 用 RVC 换成她的声音 → 混音 → 发语音条。主人在 QQ 里说「唱首歌」，或者发 /sing 歌名 都行。' },
      h('div', { className: cx('ab-note', s.ready ? '' : 'warn') }, s.message),
      h('div', { className: 'ab-checks', style: { marginTop: 12 } },
        SONG_PARTS.map(([k, label]) => h('div', { key: k, className: cx('ab-check', s.parts[k] && 'done') }, h('i', null, s.parts[k] ? '✓' : '·'), label)),
        h('div', { className: cx('ab-check', s.voices.length && 'done'), title: s.voices.map((v) => v.id).join('、') }, h('i', null, s.voices.length ? '✓' : '·'), s.voices.length ? '音色模型 ×' + s.voices.length : '音色模型（在下面导入）')),
      s.install.running ? null : h('div', { style: { marginTop: 12 } },
        h(Row, { label: '装到哪里', hint: '装完约 8 GB，音色模型也放这里。改了要先保存设置再点安装' }, h(RootPicker, { draft, setDraft, s })),
        h(Row, { label: '下载源', hint: '自动：安装前先测一下，官方源慢就用国内镜像（阿里云 / 南京大学 / npmmirror）' },
          h(Select, { value: draft.song.pypiMirror || 'auto', width: 220, onChange: (v) => setDraft(setPath(draft, 'song.pypiMirror', v)), options: [{ value: 'auto', label: '自动（推荐）' }, { value: 'cn', label: '一直用国内镜像' }, { value: 'off', label: '只用官方源' }] }))),
      h('div', { className: 'ab-flex', style: { marginTop: 12 } },
        h(Btn, { kind: 'primary', small: true, disabled: s.install.running || (draft.song.root || '') !== (st.config.song.root || ''), onClick: async () => { const r = await post('/song/install'); toast(r.message); setTimeout(load, 800) } },
          s.install.running ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在安装…') : Object.values(s.parts).every(Boolean) ? '重新检查 / 修复安装' : '一键安装'),
        h('span', { className: 'ab-muted ab-small' }, (draft.song.root || '') !== (st.config.song.root || '') ? '安装位置改了，先保存设置' : '需要 NVIDIA 显卡；装在 ' + s.root)),
      s.install.running ? h(InstallProgress, { inst: s.install }) : null,
      s.install.ok === true && !s.install.running ? h('div', { className: 'ab-note', style: { marginTop: 8 } }, '✓ ' + s.install.message) : null,
      s.install.log.length ? h('details', { style: { marginTop: 8 } }, h('summary', { className: 'ab-muted ab-small', style: { cursor: 'pointer' } }, '详细日志'),
        h('div', { className: 'ab-logs', style: { maxHeight: 180, marginTop: 6, padding: '8px 12px', whiteSpace: 'pre-wrap' } }, s.install.log.slice(-20).join('\n'))) : null,
      s.install.ok === false && !s.install.running ? h('div', { className: 'ab-note err', style: { marginTop: 8 } },
        h('div', null, s.install.message),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(Btn, { small: true, kind: 'primary', onClick: async () => { const r = await post('/song/install'); toast(r.message); setTimeout(load, 800) } }, '再试一次'),
          h(Btn, { small: true, onClick: () => { try { navigator.clipboard.writeText(['QQ Hub ' + st.version + ' 翻唱安装失败', s.install.message, '', s.install.error || '', '', ...(s.install.log || []).slice(-30)].join('\n')); toast('报错复制好了，发给作者就行', 'ok') } catch (e) { toast('复制失败，展开「详细日志」手动复制吧', 'err') } } }, '复制报错'),
          h('span', { className: 'ab-muted ab-small' }, '已经下好的部分不会重下'))) : null,
    ),
    h(VoiceImport, { s, toast, onChange: load }),
    h(Card, { title: '声音', desc: '用哪个音色唱、默认变调和语音条的长度。' },
      h(Row, { label: '音色' }, voices.length ? h(Select, { value: draft.song.voice || (voices[0] && voices[0].value), options: voices, onChange: (v) => setDraft(setPath(draft, 'song.voice', v)) }) : h('span', { className: 'ab-muted' }, '还没有模型')),
      h(Row, { label: '默认变调', hint: '她自己点歌时会按原唱男声 / 女声定，这里是你在面板里试唱时的默认值' }, f.range('song.pitch', -12, 12, 1, (v) => (v > 0 ? '+' : '') + v + ' 半音')),
      h(Row, { label: '语音条最长', hint: '歌比这个长就截一段' }, f.range('song.maxVoiceSec', 30, 300, 10, (v) => v + ' 秒')),
      h(Row, { label: '截哪一段' }, f.choices('song.clipStart', [{ value: 'auto', label: '副歌附近', desc: '从全曲大约 30% 的地方开始' }, { value: 'head', label: '从头开始' }])),
      h(Row, { label: '人声音量' }, f.range('song.vocalVolume', 0.2, 2, 0.05, (v) => Math.round(v * 100) + '%')),
      h(Row, { label: '伴奏音量' }, f.range('song.instVolume', 0.1, 2, 0.05, (v) => Math.round(v * 100) + '%')),
      h(Row, { label: '只有主人能点歌' }, f.sw('song.ownerOnly')),
    ),
    h(Card, { title: '网易云', desc: '不登录也能唱免费歌；会员歌、版权歌要填网易云的 Cookie。' },
      h(Row, { label: 'Cookie（MUSIC_U）', hint: '电脑浏览器登录 music.163.com → F12 → 应用 / 存储 → Cookie → 复制 MUSIC_U 的值。只存在本机，不显示' },
        f.text('song.neteaseCookie', { type: 'password', size: 'wide', placeholder: draft.song.neteaseCookieSet ? '已保存（不改就留空）' : '没有就留空' })),
      h('div', { className: 'ab-flex', style: { marginTop: 6 } },
        h(Btn, { small: true, onClick: async () => { const r = await get('/song/account'); setAcct(r) } }, '检查登录'),
        acct ? h('span', { className: 'ab-small', style: { color: acct.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, acct.ok ? '已登录：' + acct.nickname + (acct.vip ? '（会员）' : '（不是会员，只能下免费歌）') : acct.message) : null),
    ),
    h(Card, { title: '试唱', desc: '搜一首歌让她唱，做好会发到你的 QQ 私聊。' },
      h('div', { className: 'ab-flex' },
        h('input', { className: 'ab-input', style: { flex: '1 1 260px' }, placeholder: '歌名，可以带歌手：小幸运 田馥甄', value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => e.key === 'Enter' && search() }),
        h(Btn, { small: true, onClick: search, disabled: !q.trim() }, '搜索'),
        h('span', { className: 'ab-muted ab-small' }, '变调'),
        h('input', { className: 'ab-input sm', type: 'number', min: -24, max: 24, value: pitch, onChange: (e) => setPitch(Number(e.target.value) || 0) })),
      found === null ? null : found.length === 0 ? h('div', { className: 'ab-muted', style: { marginTop: 8 } }, '没搜到') :
        h('table', { className: 'ab-table', style: { marginTop: 10 } }, h('tbody', null, found.map((x) => h('tr', { key: x.id },
          h('td', null, x.name, x.vip ? h('span', { className: 'ab-badge', style: { marginLeft: 6 } }, '会员') : null),
          h('td', { className: 'ab-muted' }, x.artists),
          h('td', { className: 'ab-muted' }, Math.floor(x.durationSec / 60) + ':' + String(x.durationSec % 60).padStart(2, '0')),
          h('td', null, h(Btn, { small: true, kind: 'primary', disabled: !s.ready || !draft.song.enabled, onClick: () => sing(x) }, '唱给我听')))))),
      !draft.song.enabled ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '先打开上面的「翻唱」开关并保存。') : null,
      s.current ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, h('i', { className: 'ab-spin' }), ' 正在唱「' + s.current.title + '」：' + s.current.stage + (s.queue.length ? '（后面还有 ' + s.queue.length + ' 首）' : '')) : null,
      s.history.length ? h('div', { className: 'ab-list', style: { marginTop: 10 } }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
        h('div', { className: 'meta' }, timeAgo(x.at)),
        h('div', { className: 'body' }, (x.ok ? '✓ ' : '✗ ') + x.title + (x.voice ? ' · ' + x.voice + (x.pitch ? ' ' + (x.pitch > 0 ? '+' : '') + x.pitch : '') : ''), h('div', { className: 'ab-muted ab-small' }, x.message))))) : null,
    ),
  )
}

/** B 站 Cookie：SESSDATA 和 bili_jct 分两个框填（前缀已经写好），可以显示 / 隐藏；粘整串也行，会自动拆开。 */

export { Song, RootPicker, InstallProgress, VoiceImport, SONG_PARTS, fmtBytes, fmtDur }
