import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../../core/react.js'
import { Card, Row, Btn, Switch, Select, Range, ModOff } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'
import { setPath, getPath } from '../../core/utils.js'
import { get, post } from '../../core/http.js'

function MultiParser({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [testUrl, setTestUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [status, setStatus] = useState(null)

  const loadStatus = () => get('/multi-parser/status').then((r) => r.ok && setStatus(r)).catch(() => {})
  useEffect(() => { loadStatus() }, [])

  const doTest = async () => {
    if (!testUrl.trim()) return toast('请先输入要测试的平台链接', 'err')
    setBusy(true)
    setTestResult(null)
    try {
      const r = await post('/multi-parser/test', { url: testUrl.trim() })
      setBusy(false)
      if (!r.ok) return toast(r.message || '解析失败', 'err')
      setTestResult(r.result)
      toast('解析成功！', 'ok')
    } catch (e) {
      setBusy(false)
      toast('请求失败：' + e.message, 'err')
    }
  }

  const platforms = [
    { key: 'bilibili', label: 'Bilibili 视频 / 动态 / 专栏 / 短链' },
    { key: 'douyin', label: '抖音视频 / 汽水音乐' },
    { key: 'redbook', label: '小红书笔记 / 视频 / 图集' },
    { key: 'weibo', label: '微博博文 / 高清大图 / 视频' },
    { key: 'zhihu', label: '知乎问答 / 专栏文章 / 想法' },
    { key: 'wechat', label: '微信公众号文章' },
    { key: 'tieba', label: '百度贴吧帖子 / 楼主正文与配图' },
    { key: 'fanqie', label: '番茄小说书名 / 简介 / 封面' },
    { key: 'github', label: 'GitHub 公开仓库卡片 / Star' },
    { key: 'xiaoheihe', label: '小黑盒社区资讯' },
  ]

  return h('div', { className: 'ab-grid' },
    h(Card, {
      title: '多平台内容解析',
      right: f.sw('multiParser.enabled'),
      desc: '自动识别群聊和私聊中的多平台内容链接（B站、小红书、微博、知乎、抖音、公众号等），提取无水印视频、高清图集与摘要；可自动发送媒体，并可作为上下文喂给大模型。',
    },
      h(Row, {
        label: '群聊里提供解析',
        hint: '关掉后群里发链接完全不管（不发卡片、不下载视频）。只想在私聊用就关掉它。',
      }, f.sw('multiParser.inGroups')),
      h(Row, {
        label: '私聊里提供解析',
        hint: '关掉后私聊发链接也不解析，只有群聊生效。',
      }, f.sw('multiParser.inPrivate')),
      h(Row, {
        label: '这些群不解析',
        hint: '群号用逗号或空格隔开。列在这里的群即使「群聊里提供解析」开着也不解析。',
      }, h('input', {
        className: 'ab-input',
        style: { width: '100%' },
        placeholder: '例如 123456789, 987654321',
        value: (Array.isArray(draft.multiParser?.disabledGroups) ? draft.multiParser.disabledGroups : []).join(', '),
        onChange: (e) => setDraft((prev) => setPath(prev, 'multiParser.disabledGroups', String(e.target.value).split(/[\s,，;；]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 4))),
      })),
      h(Row, {
        label: '大模型上下文注入（AI 看懂链接）',
        hint: '🌟 核心开关：开启后，自动将解析出的标题、作者、正文摘要喂给 AI，让她能看懂群友分享并自然接话讨论；关闭则仅作为纯工具运行。',
      }, f.sw('multiParser.feedToAi')),
      h(Row, {
        label: '纯解析：解析后不让她接话',
        hint: '开启后，只要解析成功就只发卡片和媒体，不再唤醒她回复这条消息。适合视频类内容——她看不到画面，硬接话只能靠标题和分享口令里的字去编。',
      }, f.sw('multiParser.muteAi')),
      h(Row, {
        label: '发送解析媒体到 QQ',
        hint: '开启后将解析出的无水印视频或高清图集直接发送到聊天中。',
      }, f.sw('multiParser.sendMedia')),
      h(Row, {
        label: '图文发送策略',
        hint: '多图时是否打包为 QQ 聊天记录合并转发卡片（防刷屏）。',
      },
        f.select('multiParser.forwardMode', [
          { value: 'threshold', label: '超过图片阈值时合并转发 (推荐)' },
          { value: 'always', label: '总是使用合并转发卡片' },
          { value: 'never', label: '逐条发送普通图片消息' },
        ], { width: 220 })
      ),
      h(Row, {
        label: '合并转发图片张数门槛',
        hint: '达到此图片张数时自动转为合并转发卡片。',
      }, f.num('multiParser.imageThreshold', { min: 1, max: 20, fallback: 2 })),
    ),

    h(Card, {
      title: '视频发送策略',
      desc: '探测到视频链接时的直接发送上限与体积超限处理动作。',
    },
      h(Row, {
        label: '单视频直接发送上限 (MB)',
        hint: '低于此体积直接在聊天中发送原生播放视频气泡，超过则执行超限动作。',
      }, f.num('multiParser.maxVideoMB', { min: 5, max: 200, step: 5, fallback: 100 })),
      h(Row, {
        label: '视频超限处理动作',
        hint: '当视频体积超出上限时采取的动作。',
      },
        f.select('multiParser.videoOverLimit', [
          { value: 'direct_link', label: '发送高速下载直链' },
          { value: 'group_file', label: '上传至群文件 (群聊有效)' },
          { value: 'notice', label: '仅发送超限文字通知' },
        ], { width: 200 })
      ),
    ),

    h(Card, {
      title: '支持平台独立开关',
      desc: '单独控制是否响应特定平台的链接。',
    },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '8px 16px', padding: '6px 0' } },
        platforms.map((p) =>
          h('div', { key: p.key, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--ab-line)' } },
            h('span', { style: { fontSize: 13 } }, p.label),
            f.sw(`multiParser.platforms.${p.key}`)
          )
        )
      )
    ),

    h(Card, {
      title: '平台 Cookies 配置（可选）',
      desc: '为部分平台提供登录后的 Cookie，以获取更高清晰度媒体、避免接口风控或解除未登录限制。留空的平台将走免登录公开接口。',
    },
      [
        { key: 'bilibili', label: 'B站 Cookie', hint: '用于解析高清视频流及动态；留空自动复用「B站」页已配 Cookie', fallback: (d) => Boolean(d.bili?.cookie || d.bili?.sessdata) },
        { key: 'weibo', label: '微博 Cookie', hint: '填写包含 SUB 的 Cookie，可避免微博移动端接口触发 403/418 风控' },
        { key: 'redbook', label: '小红书 Cookie', hint: '填写包含 a1、web_session 的 Cookie，提升笔记图集提取稳定性' },
        { key: 'zhihu', label: '知乎 Cookie', hint: '填写包含 z_c0 的 Cookie，用于获取知乎完整回答与文章' },
        { key: 'tieba', label: '百度贴吧 Cookie', hint: '填写包含 BDUSS 的 Cookie，用于获取贴吧高清原图' },
        { key: 'xiaoheihe', label: '小黑盒 Cookie', hint: '留空自动复用「小黑盒」页已配 Cookie', fallback: (d) => Boolean(d.heybox?.cookie) },
        { key: 'douyin', label: '抖音 Cookie', hint: '选填，用于抖音网页端接口鉴权' },
      ].map((cp) => {
        const isSet = Boolean(getPath(draft, `multiParser.cookies.${cp.key}Set`))
        const isFallback = !isSet && cp.fallback && cp.fallback(draft)
        const statusBadge = isSet
          ? h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)', marginLeft: 8 } }, '✓ 已专属配置')
          : (isFallback ? h('span', { className: 'ab-small', style: { color: 'var(--ab-sea)', marginLeft: 8 } }, '✓ 自动复用全局') : null)

        return h(Row, {
          key: cp.key,
          label: h('span', null, cp.label, statusBadge),
          hint: cp.hint,
        },
          f.text(`multiParser.cookies.${cp.key}`, {
            type: 'password',
            placeholder: (isSet || isFallback) ? '●●●●●●（已生效，留空保持不变）' : '粘贴整串 Cookie 或关键字段',
          })
        )
      })
    ),

    h(Card, {
      title: '在线测试解析',
      desc: '粘贴任意受支持的链接，实时测试解析效果并预览结果卡片。',
    },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('input', {
          className: 'ab-input',
          style: { flex: 1 },
          placeholder: '例如 https://www.bilibili.com/video/BV... 或 微博/知乎/小红书链接',
          value: testUrl,
          onChange: (e) => setTestUrl(e.target.value),
        }),
        h(Btn, { kind: 'primary', disabled: busy, onClick: doTest }, busy ? '解析中…' : '测试解析')
      ),
      testResult ? h('div', { style: { marginTop: 12, padding: 12, background: 'var(--ab-card-2)', borderRadius: 8, border: '1px solid var(--ab-line)' } },
        h('div', { style: { fontWeight: 600, color: 'var(--ab-deep)', marginBottom: 4 } }, `[${testResult.platformName}] ${testResult.title}`),
        testResult.author ? h('div', { className: 'ab-small ab-muted' }, `作者：${testResult.author}`) : null,
        testResult.summary ? h('div', { className: 'ab-small', style: { margin: '6px 0', whiteSpace: 'pre-wrap' } }, testResult.summary) : null,
        testResult.stat ? h('div', { className: 'ab-small ab-muted' }, testResult.stat) : null,
        testResult.videoUrl ? h('div', { className: 'ab-small', style: { color: 'var(--ab-ok)', margin: '4px 0' } }, `📹 已嗅探到视频直链`) : null,
        testResult.images && testResult.images.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, `🖼️ 共提取到 ${testResult.images.length} 张图片`) : null,
      ) : null
    )
  )
}

/** 「她的画作」：读存图目录里最近的 N 张，可以单张删除、开文件夹。 */

export { MultiParser }
