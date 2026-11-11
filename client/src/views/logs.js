import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Btn, Empty, Switch, Select } from '../ui/primitives.js'
import { get } from '../core/http.js'
import { LogLine } from './overview.js'

function Logs() {
  const [items, setItems] = useState(null)
  const [level, setLevel] = useState('info')
  const [area, setArea] = useState('')
  const [auto, setAuto] = useState(true)
  const load = useCallback(() => get('/logs?limit=400&level=' + level + '&area=' + area).then((r) => setItems(r.entries || [])), [level, area])
  useEffect(() => { load(); if (!auto) return; const t = setInterval(load, 3000); return () => clearInterval(t) }, [load, auto])
  return h(Card, { title: '日志', desc: '所有后台动作都在这里，令牌和密码已自动打码。完整日志文件在 %USERPROFILE%\\.dsh\\plugins-data\\dsh-qq-hub\\logs\\（老安装为 aurabot\\）。',
    right: h('div', { className: 'ab-flex' },
      h(Select, { value: level, onChange: setLevel, width: 110, options: [['debug', '全部'], ['info', '一般'], ['warn', '警告'], ['error', '错误']].map(([value, label]) => ({ value, label })) }),
      h(Select, { value: area, onChange: setArea, width: 130, options: [['', '所有模块'], ['core', '核心'], ['chat', '聊天'], ['onebot', 'QQ 网关'], ['snowluma', 'SnowLuma'], ['sticker', '表情'], ['qzone', '空间'], ['voice', '语音'], ['imagegen', '生图'], ['speakup', '搭话']].map(([value, label]) => ({ value, label })) }),
      h('span', { className: 'ab-switch-row' }, h(Switch, { on: auto, onChange: setAuto }), h('span', { className: 'ab-muted ab-small' }, '自动刷新'))) },
    items === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(Empty, { text: '没有符合条件的日志' }) :
      h('div', { className: 'ab-logs' }, items.slice().reverse().map((e, i) => h(LogLine, { key: i, e }))))
}

// ---------------- 首次使用向导 ----------------

export { Logs }
