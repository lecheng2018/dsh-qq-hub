import { useState, useEffect, useRef, h } from '../core/react.js'
import { Card, Row, Btn, Empty } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { API } from '../core/api-base.js'
import { get, post, readJson } from '../core/http.js'
import { setPath, cx } from '../core/utils.js'

const PROTECTED = new Set(['manual', 'panel', 'qq', 'tool', 'pack'])
const SOURCE_NAMES = { auto: '偷来的', manual: '手动', panel: '面板', qq: 'QQ 收藏', tool: '工具', pack: '图包', painting: '画作' }

function Stickers({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [items, setItems] = useState(null)
  const [meta, setMeta] = useState({ max: 300, protectedCount: 0, over: 0 })
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [sort, setSort] = useState('new')
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState('')
  const [drag, setDrag] = useState(false)
  const [newName, setNewName] = useState('')
  const [newGid, setNewGid] = useState('')
  const fileRef = useRef(null)
  const packRef = useRef(null)

  const load = async () => {
    const r = await get('/stickers')
    setItems(r.items || [])
    setMeta({ max: Number(r.max) || 300, protectedCount: Number(r.protectedCount) || 0, over: Number(r.over) || 0 })
    const alive = new Set((r.items || []).map((i) => i.md5))
    setSelected((prev) => new Set([...prev].filter((md5) => alive.has(md5))))
  }
  useEffect(() => { load() }, [])

  const upload = async (files) => {
    const list = [...(files || [])]
    if (!list.length) return
    let ok = 0
    const errs = []
    setBusy('上传中…')
    for (const file of list) {
      if (file.size > 5 * 1024 * 1024) { errs.push(file.name + ' 超过 5MB'); continue }
      try {
        const name = list.length === 1 ? newName.trim().slice(0, 12) : ''
        const res = await fetch(API + '/sticker/upload?name=' + encodeURIComponent(name), {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        })
        const r = await readJson(res)
        if (r.ok) ok++
        else errs.push(file.name + '：' + (r.reason || r.warning || r.message || '没加成功'))
      } catch (error) {
        errs.push(file.name + '：' + error.message)
      }
    }
    setBusy('')
    setNewName('')
    toast(errs.length ? (ok ? `加好 ${ok} 张；` : '') + errs.join('；') : `加好了 ${ok} 张`, errs.length ? 'err' : 'ok')
    load()
  }

  const importPack = async (file) => {
    if (!file) return
    if (file.size > 64 * 1024 * 1024) return toast('图包超过 64MB', 'err')
    setBusy('导入图包中…')
    try {
      const res = await fetch(API + '/sticker/pack/import', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      })
      const r = await readJson(res)
      toast(r.message || (r.ok ? '导入完成' : '导入失败'), r.ok === false ? 'err' : 'ok')
    } catch (error) {
      toast('导入失败：' + error.message, 'err')
    } finally {
      setBusy('')
      load()
    }
  }

  const filtered = (items || []).filter((it) => {
    const q = query.trim()
    if (q && !String(it.name || '').includes(q) && !(it.tags || []).some((t) => String(t).includes(q)) && !String(it.md5 || '').startsWith(q.toLowerCase())) return false
    if (source === 'pending') return Boolean(it.pending)
    if (source === 'unsynced') return Boolean(it.qqError)
    if (source === 'auto') return !PROTECTED.has(String(it.from || ''))
    if (source === 'manual') return ['manual', 'panel', 'tool', 'painting'].includes(String(it.from || ''))
    if (source === 'qq' || source === 'pack') return String(it.from || '') === source
    return true
  }).sort((a, b) => {
    if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
    if (sort === 'uses') return (Number(b.uses) || 0) - (Number(a.uses) || 0)
    if (sort === 'size') return (Number(b.bytes) || 0) - (Number(a.bytes) || 0)
    return (Number(b.at) || 0) - (Number(a.at) || 0)
  })
  const allVisibleSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.md5))
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) for (const it of filtered) next.delete(it.md5)
      else for (const it of filtered) next.add(it.md5)
      return next
    })
  }
  const toggleOne = (md5) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(md5)) next.delete(md5)
    else next.add(md5)
    return next
  })
  const bulkDelete = async () => {
    if (!selected.size) return
    if (!confirm(`删掉选中的 ${selected.size} 张表情？（QQ 收藏里也会删）`)) return
    setBusy('删除中…')
    const r = await post('/sticker/delete-batch', { md5s: [...selected] })
    setBusy('')
    toast(r.ok ? `删掉了 ${r.removed} 张${r.missing ? `，${r.missing} 张没找到` : ''}` : (r.reason || '没删成'), r.ok ? 'ok' : 'err')
    setSelected(new Set())
    load()
  }

  const overrides = draft.stickers && draft.stickers.overrides ? draft.stickers.overrides : {}
  const patchOverride = (gid, patch) => setDraft((prev) => {
    const cur = (prev.stickers.overrides || {})[gid] || {}
    return setPath(prev, 'stickers.overrides', { ...(prev.stickers.overrides || {}), [gid]: { ...cur, ...patch } })
  })
  const removeOverride = (gid) => setDraft((prev) => {
    const next = { ...(prev.stickers.overrides || {}) }
    delete next[gid]
    return setPath(prev, 'stickers.overrides', next)
  })

  return (
    <div className="ab-grid">
      <Card
        title="表情包" right={f.sw('stickers.enabled')}
        desc="回复里写 <sticker:名字> 就会发对应的表情；也会按概率自动配一张。"
      >
        <Row label="自动配表情的概率">{f.percent('stickers.autoChance')}</Row>
        <Row label="自动配图冷却" hint="两次自动配图至少隔多久；显式让她发不受影响">{f.num('stickers.cooldownSec', { min: 0, max: 3600 })}<span className="ab-muted">秒</span></Row>
        <Row label="每小时自动配图上限" hint="按聊天分别算；0 = 不限">{f.num('stickers.sendMaxPerHour', { min: 0, max: 500 })}<span className="ab-muted">张</span></Row>
        <Row label="夹 QQ 小黄脸" hint="回复里能夹 QQ 自带的系统表情（/捂脸 /斜眼笑 这种），和文字在同一条消息里">{f.sw('stickers.faces')}</Row>
        <Row label="偷表情" hint="别人发的表情包会被收藏（普通照片不收）。关掉就完全不收。">{f.sw('stickers.collect')}</Row>
        {/* 来源过滤：默认值都是 true，所以用 !== false 判断「开着」（老配置里可能没有这个键） */}
        {draft.stickers.collect !== false ? (
          <Row label="从哪收" hint="两个都关等于不偷，只留一个就只从那边收。">
            <span className="ab-muted">群聊</span>{f.sw('stickers.fromGroups')}
            <span className="ab-muted" style={{ marginLeft: 16 }}>私聊</span>{f.sw('stickers.fromPrivate')}
          </Row>
        ) : null}
        {draft.stickers.collect !== false ? (
          <Row label="怎么偷" hint="「她挑」只递给她看，喜欢才收；「只听主人的」只在主人私聊 / 这一轮只有主人时她才可自己收，有别人在场要主人发话">
            {f.choices('stickers.collectMode', [
              { value: 'auto', label: '全都偷', desc: '看到就收，不用她同意（默认）' },
              { value: 'ask', label: '她挑', desc: '先记着，给她一句轻提示，喜欢才凭编号收' },
              { value: 'owner', label: '只听主人的', desc: '只有主人私聊 / 只有主人时她才可自己收；别人在场要主人发话' },
            ])}
          </Row>
        ) : null}
        <Row label="每小时最多收">{f.num('stickers.maxPerHour', { min: 0 })}<span className="ab-muted">张 / 每个聊天</span></Row>
        <Row label="表情库最多存" hint="超过这个数会先清掉最少用的「偷来的」；你自己加的、从 QQ/图包导入的不会被自动清理">
          {f.num('stickers.maxLibrary', { min: 20, max: 2000 })}<span className="ab-muted">张</span>
        </Row>
        <Row label="看图起名" hint="收下后让模型看图起个 12 字以内的备注；起名前不会进自动配图池">{f.sw('stickers.caption')}</Row>
        <Row label="WebP 转 JPEG" hint="兼容优先：发送前转成 JPEG，会丢动画；原图仍保留">{f.sw('stickers.webpToJpeg')}</Row>
      </Card>

      <Card
        title={'表情库' + (items ? '（' + items.length + ' 张）' : '')}
        desc={meta.over > 0 ? `超过上限 ${meta.over} 张，而且剩下的都是手动添加/导入的表情；再收新表情会失败，需要先删一些。` : '支持搜索、按来源筛选、排序和批量删除；也可以把整库导出成图包。'}
        right={(
          <div className="ab-flex">
            <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
            <input ref={packRef} type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={(e) => { importPack(e.target.files[0]); e.target.value = '' }} />
            <input className="ab-input sm" style={{ width: 130 }} placeholder="名字（可不填）" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Btn small onClick={() => fileRef.current && fileRef.current.click()}>＋ 上传</Btn>
            <Btn small kind="ghost" onClick={() => packRef.current && packRef.current.click()}>导入图包</Btn>
            <a className="ab-btn sm ghost" href={API + '/sticker/pack/export'} download>导出图包</a>
            <Btn small title="把机器人号 QQ「我喜欢的」里已有的表情导进来" onClick={async () => { setBusy('从 QQ 收藏导入…'); const r = await post('/sticker/import-qq'); setBusy(''); toast(r.message, r.ok === false ? 'err' : 'ok'); load() }}>从 QQ 收藏导入</Btn>
            <Btn small kind="ghost" onClick={load}>刷新</Btn>
          </div>
        )}
      >
        <div className="ab-sticker-tools">
          <input className="ab-input" placeholder="搜名字 / 标签 / md5" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="ab-select" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">全部来源</option>
            <option value="auto">偷来的</option>
            <option value="manual">手动 / 面板</option>
            <option value="qq">QQ 收藏</option>
            <option value="pack">图包</option>
            <option value="pending">待起名</option>
            <option value="unsynced">QQ 未同步</option>
          </select>
          <select className="ab-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="new">最新在前</option>
            <option value="name">按名字</option>
            <option value="uses">常用在前</option>
            <option value="size">体积从大到小</option>
          </select>
          <label className="ab-muted ab-small ab-flex" style={{ gap: 4 }}>
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} /> 全选当前
          </label>
          {selected.size ? <Btn small kind="ghost" onClick={bulkDelete}>删除选中（{selected.size}）</Btn> : null}
          {busy ? <span className="ab-muted ab-small">{busy}</span> : null}
        </div>
        <div
          className={cx('ab-sticker-drop', drag && 'on')}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}
        >
          {items === null
            ? <Empty icon="⏳" text="加载中…" />
            : filtered.length === 0
              ? <Empty icon="🐳" text={items.length ? '没有符合筛选的表情。' : '表情库还是空的。别人发表情包她会自己收；也可以上传、导入图包，或从 QQ 收藏导入。'} />
              : <div className="ab-stickers">{filtered.map((it) => <StickerCell key={it.md5} it={it} selected={selected.has(it.md5)} onToggle={toggleOne} onChanged={load} toast={toast} />)}</div>}
        </div>
      </Card>

      <Card title="按群单独设置" desc="某个群想让她安静点、别偷表情或别自动配图，在这里单独设；只影响群聊，私聊仍按上面的全局设置。">
        {Object.keys(overrides).length === 0
          ? <div className="ab-muted" style={{ marginBottom: 10 }}>还没有单独设置的群。</div>
          : Object.entries(overrides).map(([gid, o]) => (
            <div className="ab-sticker-policy" key={gid}>
              <div className="ab-flex" style={{ marginBottom: 6 }}>
                <b>群 {gid}</b>
                <div className="ab-spacer" />
                <span className="ab-muted ab-small">关掉总开关 = 这个群完全不发表情</span>
                <Btn small kind="ghost" onClick={() => removeOverride(gid)}>移除</Btn>
              </div>
              <Row label="发表情"><label className="ab-muted ab-small ab-flex" style={{ gap: 6 }}><input type="checkbox" checked={o.enabled !== false} onChange={(e) => patchOverride(gid, { enabled: e.target.checked })} /> 开启</label></Row>
              <Row label="偷表情"><label className="ab-muted ab-small ab-flex" style={{ gap: 6 }}><input type="checkbox" checked={o.collect !== false} onChange={(e) => patchOverride(gid, { collect: e.target.checked })} /> 开启</label></Row>
              <Row label="自动配图概率">
                <input className="ab-input sm" type="number" min={0} max={100} value={Math.round((o.autoChance ?? draft.stickers.autoChance ?? 0) * 100)} onChange={(e) => patchOverride(gid, { autoChance: Number(e.target.value) / 100 })} />
                <span className="ab-muted">%</span>
              </Row>
              <Row label="冷却 / 每小时上限">
                <input className="ab-input sm" type="number" min={0} max={3600} value={o.cooldownSec ?? 0} onChange={(e) => patchOverride(gid, { cooldownSec: Number(e.target.value) })} />
                <span className="ab-muted">秒 /</span>
                <input className="ab-input sm" type="number" min={0} max={500} value={o.sendMaxPerHour ?? 0} onChange={(e) => patchOverride(gid, { sendMaxPerHour: Number(e.target.value) })} />
                <span className="ab-muted">张（0=不限）</span>
              </Row>
            </div>
          ))}
        <div className="ab-flex">
          <input className="ab-input" placeholder="群号" value={newGid} onChange={(e) => setNewGid(e.target.value.replace(/\D/g, ''))} />
          <Btn small disabled={!newGid} onClick={() => { patchOverride(newGid, { enabled: true }); setNewGid('') }}>添加</Btn>
        </div>
      </Card>
    </div>
  )
}

/** 一张表情：名字（备注）和标签都能直接改，改完离开输入框就保存（#31：模型起的名字 / 标签不对时手动纠正）。 */
function StickerCell({ it, selected, onToggle, onChanged, toast }) {
  const [name, setName] = useState(it.name || '')
  const tagText = (it.tags || []).join(' ')
  const [tags, setTags] = useState(tagText)
  useEffect(() => {
    setName(it.name || '')
    setTags((it.tags || []).join(' '))
  }, [it.md5, it.name, tagText])
  const save = async (body, label) => {
    const r = await post('/sticker/rename', { md5: it.md5, ...body })
    toast(r.ok ? label + '改好了' : (r.reason || '没改成'), r.ok ? 'ok' : 'err')
    if (r.ok) onChanged()
    else {
      setName(it.name || '')
      setTags((it.tags || []).join(' '))
    }
  }
  const sourceName = SOURCE_NAMES[String(it.from || '')] || (String(it.from || '').startsWith('group:') ? '群里偷的' : String(it.from || '').startsWith('private:') ? '私聊偷的' : '手动')
  return (
    <div className={cx('ab-sticker', selected && 'sel')}>
      <label className="ab-sticker-check" title="选中">
        <input type="checkbox" checked={selected} onChange={() => onToggle(it.md5)} />
      </label>
      <img src={API + '/sticker/image?md5=' + it.md5 + '&thumb=1'} alt={it.name || '表情'} loading="lazy" />
      <div className="ab-sticker-badges">
        <span className="ab-badge dim">{sourceName}</span>
        {it.pending ? <span className="ab-badge warn">待起名</span> : null}
        {it.qqError ? <span className="ab-badge err" title={it.qqError}>QQ 未同步</span> : null}
        {it.uses ? <span className="ab-badge dim">{it.uses} 次</span> : null}
      </div>
      <input
        className="nm" value={name} placeholder="未命名（点这里改）" title="名字 / 备注，最多 12 字" maxLength={12}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name !== (it.name || '')) save({ name }, '名字') }}
      />
      <input
        className="tg" value={tags} placeholder="加标签，空格隔开" title="标签，空格或逗号隔开，最多 5 个"
        onChange={(e) => setTags(e.target.value)}
        onBlur={() => { if (tags.trim() !== tagText) save({ tags: tags.split(/[\s,，、#]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5) }, '标签') }}
      />
      <button
        type="button" className="ab-btn sm danger x" title="删除"
        onClick={async () => { if (!confirm('删掉这张表情？（QQ 收藏里也会删）')) return; await post('/sticker/delete', { md5: it.md5 }); onChanged() }}
      >
        ✕
      </button>
    </div>
  )
}

export { Stickers }
