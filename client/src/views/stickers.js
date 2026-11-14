import { useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Empty, More } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { API } from '../core/api-base.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

function Stickers({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [items, setItems] = useState(null)
  const fileRef = useRef(null)
  const load = () => get('/stickers').then((r) => setItems(r.items || []))
  useEffect(() => { load() }, [])
  const [newName, setNewName] = useState('')
  // DSH 是 Electron，不支持 prompt() 弹框：名字在页面上填（不填就自动看图起名）
  const upload = async (files) => {
    const list = [...(files || [])]
    if (!list.length) return
    let ok = 0
    const errs = []
    for (const file of list) {
      if (file.size > 5 * 1024 * 1024) { errs.push(file.name + ' 超过 5MB'); continue }
      try {
        const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读不了这个文件')); fr.readAsDataURL(file) })
        const r = await post('/sticker/upload', { data, name: list.length === 1 ? newName.trim().slice(0, 12) : '' })
        if (r.ok) ok++
        else errs.push(file.name + '：' + (r.reason || r.message || '没加成功'))
      } catch (e) {
        errs.push(file.name + '：' + e.message)
      }
    }
    setNewName('')
    toast(errs.length ? (ok ? `加好 ${ok} 张；` : '') + errs.join('；') : `加好了 ${ok} 张`, errs.length ? 'err' : 'ok')
    load()
  }
  return (
    <div className="ab-grid">
      <Card
        title="表情包" right={f.sw('stickers.enabled')}
        desc="回复里写 <sticker:名字> 就会发对应的表情；也会按概率自动配一张。"
      >
        <Row label="自动配表情的概率">{f.percent('stickers.autoChance')}</Row>
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
        <Row label="每小时最多收">{f.num('stickers.maxPerHour', { min: 0 })}<span className="ab-muted">张</span></Row>
        <Row label="表情库最多存" hint="QQ 收藏表情有数量上限，满了就收不进去了。超过这个数会自动清掉最少用的偷来的表情（你自己加的不会动）">
          {f.num('stickers.maxLibrary', { min: 20, max: 2000 })}<span className="ab-muted">张</span>
        </Row>
        <Row label="看图起名" hint="收下后让模型看图起个 12 字以内的备注">{f.sw('stickers.caption')}</Row>
      </Card>
      <Card
        title={'表情库' + (items ? '（' + items.length + ' 张）' : '')}
        right={(
          <div className="ab-flex">
            <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
            <input className="ab-input sm" style={{ width: 140 }} placeholder="名字（可不填）" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Btn small onClick={() => fileRef.current && fileRef.current.click()}>＋ 上传</Btn>
            <Btn small title="把机器人号 QQ「我喜欢的」里已有的表情导进来" onClick={async () => { toast('正在从 QQ 收藏导入…'); const r = await post('/sticker/import-qq'); toast(r.message, r.ok === false ? 'err' : 'ok'); load() }}>从 QQ 收藏导入</Btn>
            <Btn small kind="ghost" onClick={load}>刷新</Btn>
          </div>
        )}
      >
        {items === null
          ? <Empty icon="⏳" text="加载中…" />
          : items.length === 0
            ? <Empty icon="🐳" text="表情库还是空的。别人发表情包她会自己收；也可以上传，或从 QQ 收藏导入。" />
            : <div className="ab-stickers">{items.map((it) => <StickerCell key={it.md5} it={it} onChanged={load} toast={toast} />)}</div>}
      </Card>
    </div>
  )
}

/** 一张表情：名字（备注）和标签都能直接改，改完离开输入框就保存（#31：模型起的名字 / 标签不对时手动纠正）。 */
function StickerCell({ it, onChanged, toast }) {
  const [name, setName] = useState(it.name || '')
  const tagText = (it.tags || []).join(' ')
  const [tags, setTags] = useState(tagText)
  const save = async (body, label) => {
    const r = await post('/sticker/rename', { md5: it.md5, ...body })
    toast(r.ok ? label + '改好了' : '没改成：' + (r.message || '找不到这张表情'), r.ok ? 'ok' : 'err')
    if (r.ok) onChanged()
  }
  return (
    <div className="ab-sticker">
      <img src={API + '/sticker/image?md5=' + it.md5} alt={it.name || '表情'} loading="lazy" />
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

export { Stickers, StickerCell }
