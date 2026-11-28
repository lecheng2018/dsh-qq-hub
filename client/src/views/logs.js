import { useState, useEffect, useRef, useCallback, Fragment, h } from '../core/react.js'
import { Card, Btn, Empty, Switch, Select } from '../ui/primitives.js'
import { get } from '../core/http.js'
import { LogLine } from './overview.js'

function Logs() {
  const [items, setItems] = useState(null)
  const [level, setLevel] = useState('info')
  const [area, setArea] = useState('')
  const [auto, setAuto] = useState(true)
  // 请求序号：切等级 / 切模块时前后两包会同时在路上，旧的那包回来更晚就会盖掉新的。
  const seqRef = useRef(0)
  const load = useCallback(() => {
    const seq = ++seqRef.current
    return get('/logs?limit=400&level=' + level + '&area=' + area).then((r) => {
      if (seq !== seqRef.current) return
      setItems(r.entries || [])
    })
  }, [level, area])
  useEffect(() => { load(); if (!auto) return; const t = setInterval(load, 3000); return () => clearInterval(t) }, [load, auto])
  return (
    <Card
      title="日志"
      desc="所有后台动作都在这里，令牌和密码已自动打码。完整日志文件在 %USERPROFILE%\\.dsh\\plugins-data\\dsh-qq-hub\\logs\\（老安装为 aurabot\\）。"
      right={(
        <div className="ab-toolbar">
          <Select value={level} onChange={setLevel} width={110} options={[['debug', '全部'], ['info', '一般'], ['warn', '警告'], ['error', '错误']].map(([value, label]) => ({ value, label }))} />
          <Select
            value={area} onChange={setArea} width={130}
            options={[['', '所有模块'], ['core', '核心'], ['chat', '聊天'], ['onebot', 'QQ 网关'], ['snowluma', 'SnowLuma'], ['sticker', '表情'], ['qzone', '空间'], ['voice', '语音'], ['imagegen', '生图'], ['speakup', '搭话']].map(([value, label]) => ({ value, label }))}
          />
          <span className="ab-switch-row"><Switch on={auto} onChange={setAuto} /><span className="ab-muted ab-small">自动刷新</span></span>
        </div>
      )}
    >
      {items === null
        ? <Empty icon="⏳" text="加载中…" />
        : items.length === 0 ? <Empty text="没有符合条件的日志" />
          : <div className="ab-logs">{items.slice().reverse().map((e, i) => <LogLine key={i} e={e} />)}</div>}
    </Card>
  )
}

export { Logs }
