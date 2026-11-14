import { useState, useEffect, h } from '../../core/react.js'
import { Card, Row, Btn, SectionNav, HelpDisclosure } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'
import { setPath, getPath } from '../../core/utils.js'
import { get, post } from '../../core/http.js'

function MultiParser({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [testUrl, setTestUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)
  useEffect(() => { get('/multi-parser/status').catch(() => {}) }, [])
  const doTest = async () => {
    if (!testUrl.trim()) return toast('请先输入要测试的平台链接', 'err')
    setBusy(true); setTestResult(null)
    try {
      const r = await post('/multi-parser/test', { url: testUrl.trim() })
      if (!r.ok) return toast(r.message || '解析失败', 'err')
      setTestResult(r.result); toast('解析成功', 'ok')
    } catch (e) { toast('请求失败：' + e.message, 'err') } finally { setBusy(false) }
  }
  const platforms = [
    ['bilibili', 'Bilibili 视频 / 动态 / 专栏'], ['douyin', '抖音视频 / 汽水音乐'], ['redbook', '小红书笔记 / 视频 / 图集'],
    ['weibo', '微博博文 / 图片 / 视频'], ['zhihu', '知乎问答 / 专栏 / 想法'], ['wechat', '微信公众号文章'],
    ['tieba', '百度贴吧帖子'], ['fanqie', '番茄小说'], ['github', 'GitHub 公开仓库'], ['xiaoheihe', '小黑盒社区资讯'],
  ]
  const cookies = [
    { key: 'bilibili', label: 'B站', hint: '用于高清视频与动态；留空复用 B站页配置。', fallback: (d) => Boolean(d.bili?.cookie || d.bili?.sessdata) },
    { key: 'weibo', label: '微博', hint: '包含 SUB，可降低 403/418 风控。' },
    { key: 'redbook', label: '小红书', hint: '包含 a1、web_session，提高图集解析稳定性。' },
    { key: 'zhihu', label: '知乎', hint: '包含 z_c0，用于完整回答和文章。' },
    { key: 'tieba', label: '百度贴吧', hint: '包含 BDUSS，用于高清原图。' },
    { key: 'xiaoheihe', label: '小黑盒', hint: '留空复用小黑盒页配置。', fallback: (d) => Boolean(d.heybox?.cookie) },
    { key: 'douyin', label: '抖音', hint: '选填，用于网页端接口鉴权。' },
  ]
  return h('div', { className: 'ab-grid' },
    h(SectionNav, { items: [{ id: 'parser-basic', label: '基本行为' }, { id: 'parser-media', label: '发送策略' }, { id: 'parser-platforms', label: '平台与登录' }, { id: 'parser-test', label: '在线测试' }] }),
    h(Card, { id: 'parser-basic', title: '多平台内容解析', right: f.sw('multiParser.enabled'), summary: '识别聊天中的平台链接，提取摘要、图片和视频。' },
      h(Row, { label: '群聊中解析链接' }, f.sw('multiParser.inGroups')),
      h(Row, { label: '私聊中解析链接' }, f.sw('multiParser.inPrivate')),
      h(Row, { label: '这些群不解析', hint: '逗号或空格分隔群号' }, h('input', { className: 'ab-input', style: { width: '100%' }, placeholder: '123456789, 987654321', value: (Array.isArray(draft.multiParser?.disabledGroups) ? draft.multiParser.disabledGroups : []).join(', '), onChange: (e) => setDraft((prev) => setPath(prev, 'multiParser.disabledGroups', String(e.target.value).split(/[\s,，;；]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 4))) })),
      h(Row, { label: '让 AI 理解解析内容', hint: '把标题、作者和摘要加入对话上下文' }, f.sw('multiParser.feedToAi')),
      h(Row, { label: '解析后不再自动回复', hint: '只发解析卡片和媒体' }, f.sw('multiParser.muteAi')),
      h(HelpDisclosure, { label: 'AI 注入与免回复怎么选' }, '开启 AI 注入后，她可以围绕链接内容自然讨论。视频画面本身不会提供给模型；如果只希望发送解析结果、不希望她根据标题猜测视频内容，可同时开启“解析后不再自动回复”。')),
    h('section', { id: 'parser-media', className: 'ab-grid ab-g2' },
      h(Card, { title: '图片与媒体', summary: '控制媒体发送和多图合并方式。' },
        h(Row, { label: '发送解析媒体到 QQ' }, f.sw('multiParser.sendMedia')),
        h(Row, { label: '图文发送策略' }, f.select('multiParser.forwardMode', [{ value: 'threshold', label: '超过阈值时合并转发' }, { value: 'always', label: '总是合并转发' }, { value: 'never', label: '逐条发送图片' }], { width: 220 })),
        draft.multiParser.forwardMode === 'threshold' ? h(Row, { label: '合并转发图片阈值' }, f.num('multiParser.imageThreshold', { min: 1, max: 20, fallback: 2 }), h('span', { className: 'ab-muted' }, '张')) : null),
      h(Card, { title: '视频策略', summary: '设置原生视频体积上限和超限处理。' },
        h(Row, { label: '直接发送上限' }, f.num('multiParser.maxVideoMB', { min: 5, max: 200, step: 5, fallback: 100 }), h('span', { className: 'ab-muted' }, 'MB')),
        h(Row, { label: '超限处理' }, f.select('multiParser.videoOverLimit', [{ value: 'direct_link', label: '发送下载直链' }, { value: 'group_file', label: '上传至群文件' }, { value: 'notice', label: '仅发送超限通知' }], { width: 200 })))),
    h(Card, { id: 'parser-platforms', title: '支持平台', summary: '按平台单独开启或关闭链接解析。' },
      h('div', { className: 'ab-platform-grid' }, platforms.map(([key, label]) => h('div', { key, className: 'ab-platform-toggle' }, h('span', null, label), f.sw(`multiParser.platforms.${key}`)))),
      h(Card, { title: '登录与 Cookie', summary: '可选。留空使用公开接口；已保存的 Cookie 不会回显。', collapsible: true, defaultOpen: false }, cookies.map((cp) => {
        const isSet = Boolean(getPath(draft, `multiParser.cookies.${cp.key}Set`))
        const isFallback = !isSet && cp.fallback && cp.fallback(draft)
        return h(Row, { key: cp.key, label: cp.label, hint: cp.hint },
          h('span', { className: 'ab-small ab-muted' }, isSet ? '已专属配置' : isFallback ? '复用平台配置' : '未配置'),
          f.text(`multiParser.cookies.${cp.key}`, { type: 'password', placeholder: (isSet || isFallback) ? '已生效，留空保持不变' : '粘贴 Cookie' }))
      }))),
    h(Card, { id: 'parser-test', title: '在线测试解析', summary: '用真实配置测试一个受支持的链接。' },
      h('div', { className: 'ab-test-bar' },
        h('input', { className: 'ab-input', placeholder: '粘贴 B站、微博、知乎、小红书等链接', value: testUrl, onChange: (e) => setTestUrl(e.target.value) }),
        h(Btn, { kind: 'primary', disabled: busy, onClick: doTest }, busy ? '解析中…' : '测试解析')),
      testResult ? h('div', { className: 'ab-test-result' },
        h('div', { className: 'ab-test-title' }, `[${testResult.platformName}] ${testResult.title}`),
        testResult.author ? h('div', { className: 'ab-small ab-muted' }, `作者：${testResult.author}`) : null,
        testResult.summary ? h('div', { className: 'ab-small ab-test-summary' }, testResult.summary) : null,
        testResult.stat ? h('div', { className: 'ab-small ab-muted' }, testResult.stat) : null,
        testResult.videoUrl ? h('div', { className: 'ab-small ab-ok-text' }, '已提取视频直链') : null,
        testResult.images?.length ? h('div', { className: 'ab-small ab-muted' }, `共提取 ${testResult.images.length} 张图片`) : null) : null),
  )
}

export { MultiParser }
