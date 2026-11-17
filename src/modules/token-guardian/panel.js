// modules/token-guardian/panel.js
// 预算守门员管理面板：各聊天用量进度卡片 + 结构化摘要可视化查看 + 审核拦截自愈重置
const { useState, useEffect } = React

const fmt = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(n))
const ago = (t) => {
  if (!t) return '—'
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'
}

const STYLE_INJECTION = `
.tg-panel-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tg-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.tg-stat-box {
  padding: 10px 14px;
  background: var(--ab-surface, #f9fafb);
  border: 1px solid var(--ab-line, #e5e7eb);
  border-radius: var(--ab-radius-sm, 6px);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tg-stat-val {
  font-size: 18px;
  font-weight: 650;
  color: var(--ab-text, #111827);
}
.tg-stat-lbl {
  font-size: 12px;
  color: var(--ab-sub, #6b7280);
}
.tg-chat-card {
  padding: 14px 16px;
  background: var(--ab-card, #ffffff);
  border: 1px solid var(--ab-line, #e5e7eb);
  border-radius: var(--ab-radius-sm, 6px);
  margin-bottom: 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color .15s;
}
.tg-chat-card.warn {
  border-color: color-mix(in srgb, var(--ab-warn, #f59e0b) 45%, transparent);
}
.tg-chat-card.danger {
  border-color: color-mix(in srgb, #ef4444 50%, transparent);
}
.tg-chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.tg-chat-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tg-chat-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--ab-text, #111827);
}
.tg-chat-id {
  font-size: 12px;
  color: var(--ab-dim, #9ca3af);
}
.tg-chat-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tg-progress-bar {
  height: 7px;
  border-radius: 4px;
  background: var(--ab-line, #e5e7eb);
  overflow: hidden;
  margin-top: 2px;
}
.tg-progress-fill {
  height: 100%;
  border-radius: 4px;
  transition: width .3s ease;
}
.tg-chat-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--ab-sub, #6b7280);
  flex-wrap: wrap;
}
.tg-summary-box {
  margin-top: 6px;
  padding: 12px 14px;
  background: var(--ab-surface, #f9fafb);
  border: 1px solid var(--ab-line, #e5e7eb);
  border-radius: var(--ab-radius-sm, 6px);
  font-size: 13px;
  line-height: 1.6;
}
.tg-summary-text {
  padding: 8px 12px;
  background: var(--ab-card, #ffffff);
  border-left: 3px solid var(--ab-accent, #2563eb);
  border-radius: 4px;
  margin-top: 6px;
  color: var(--ab-text, #111827);
  white-space: pre-wrap;
}
.tg-struct-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.tg-struct-item {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
}
.tg-struct-tag {
  flex: none;
  font-weight: 600;
  color: var(--ab-accent, #2563eb);
}
@media (max-width: 720px) {
  .tg-chat-head {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .tg-chat-actions {
    justify-content: flex-end;
  }
  .tg-chat-meta {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
}
`

return function TokenGuardianPanel(props) {
  const { Card, Btn, Empty } = ui
  const [data, setData] = useState(null)
  const [busyChat, setBusyChat] = useState('')
  const [expandedSummary, setExpandedSummary] = useState({}) // chatId -> summary object or null
  const [loadingSummary, setLoadingSummary] = useState({})

  const loadStatus = async () => {
    try {
      const res = await call('/token-guardian/status')
      if (res && res.ok !== false) setData(res)
      else setData({ ok: false, items: [] })
    } catch {
      setData({ ok: false, items: [] })
    }
  }

  useEffect(() => { loadStatus() }, [])

  const requestSafe = async (shortPath, fullPath) => {
    let r = await call(shortPath)
    if (!r || r.ok === false) {
      r = await call(fullPath)
    }
    if (!r || r.ok === false) {
      try {
        const res = await fetch('/qq-hub/api' + fullPath)
        if (res.ok) r = await res.json()
      } catch {}
    }
    return r
  }

  const handleCompact = async (chatId) => {
    setBusyChat(chatId)
    try {
      const q = '?chatId=' + encodeURIComponent(chatId)
      const r = await requestSafe('/compact-now' + q, '/token-guardian/compact-now?chatId=' + encodeURIComponent(chatId))
      props.toast && props.toast((r && r.message) || (r && r.ok ? '压缩成功' : '未成功'), (r && r.ok) ? 'ok' : 'err')
      await loadStatus()
      if (expandedSummary[chatId]) {
        await toggleSummary(chatId, true)
      }
    } finally {
      setBusyChat('')
    }
  }

  const handleResetUsage = async (chatId) => {
    try {
      const q = '?chatId=' + encodeURIComponent(chatId)
      const r = await requestSafe('/reset-usage' + q, '/token-guardian/reset-usage?chatId=' + encodeURIComponent(chatId))
      props.toast && props.toast((r && r.message) || '重置成功', (r && r.ok) ? 'ok' : 'err')
      await loadStatus()
    } catch (e) {
      props.toast && props.toast('重置失败', 'err')
    }
  }

  const toggleSummary = async (chatId, forceReload = false) => {
    if (expandedSummary[chatId] && !forceReload) {
      setExpandedSummary({ ...expandedSummary, [chatId]: null })
      return
    }
    setLoadingSummary({ ...loadingSummary, [chatId]: true })
    try {
      const q = '?chatId=' + encodeURIComponent(chatId)
      const r = await requestSafe('/summary' + q, '/token-guardian/summary?chatId=' + encodeURIComponent(chatId))
      if (r && r.ok && r.summary) {
        setExpandedSummary({ ...expandedSummary, [chatId]: r.summary })
      } else {
        props.toast && props.toast((r && r.message) || '该聊天暂无生效摘要', 'warn')
      }
    } finally {
      setLoadingSummary({ ...loadingSummary, [chatId]: false })
    }
  }

  if (!data) return h(Card, { title: '用量与压缩' }, h(Empty, { icon: '⏳', text: '读取中…' }))
  if (data.ok === false) return h(Card, { title: '用量与压缩' }, h('div', { className: 'ab-note err' }, '读取用量失败（模块未在运行？）'))

  const items = data.items || []
  const threshold = data.threshold || 300000
  const highUsageCount = items.filter(it => it.tokens >= threshold).length
  const totalCompacts = items.reduce((acc, it) => acc + (it.compacts || 0), 0)

  return h('div', { className: 'tg-panel-root' },
    h('style', null, STYLE_INJECTION),

    h(Card, {
      title: '上下文用量与压缩管理',
      desc: `基于五类结构化检查点机制。当聊天上下文超过阈值 (${fmt(threshold)} token) 且空闲时，会自动执行平滑压缩，将核心事实与未结约定保留为摘要。`
    },
      // 顶部统计指标条
      h('div', { className: 'tg-stats-grid' },
        h('div', { className: 'tg-stat-box' },
          h('div', { className: 'tg-stat-val' }, items.length),
          h('div', { className: 'tg-stat-lbl' }, '监控会话总数')
        ),
        h('div', { className: 'tg-stat-box' },
          h('div', { className: 'tg-stat-val', style: { color: highUsageCount > 0 ? '#ef4444' : 'inherit' } }, highUsageCount),
          h('div', { className: 'tg-stat-lbl' }, '超阈值待压缩')
        ),
        h('div', { className: 'tg-stat-box' },
          h('div', { className: 'tg-stat-val', style: { color: 'var(--ab-accent, #2563eb)' } }, totalCompacts),
          h('div', { className: 'tg-stat-lbl' }, '已累计压缩次数')
        ),
        h('div', { className: 'tg-stat-box' },
          h('div', { className: 'tg-stat-val' }, fmt(threshold)),
          h('div', { className: 'tg-stat-lbl' }, '触发压缩阈值')
        )
      ),

      items.length === 0
        ? h(Empty, { icon: '📊', text: '暂无聊天记录，在群聊或私聊中交互后即可自动呈现。' })
        : h('div', null,
            items.map((it) => {
              const pct = Math.min(100, Math.round((it.tokens / Math.max(1, threshold)) * 100))
              const isOver = it.tokens >= threshold
              const isWarn = pct >= 65 && !isOver
              const cardClass = 'tg-chat-card' + (isOver ? ' danger' : isWarn ? ' warn' : '')
              const summaryData = expandedSummary[it.chatId]
              const isLoadingSum = loadingSummary[it.chatId]

              let progressColor = '#22c55e'
              if (isOver) progressColor = '#ef4444'
              else if (isWarn) progressColor = '#f59e0b'

              const inModCooldown = Boolean(it.moderationRemainSec && it.moderationRemainSec > 0)

              return h('div', { key: it.chatId, className: cardClass },
                // 头部：群名/私聊名 + 操作按钮
                h('div', { className: 'tg-chat-head' },
                  h('div', { className: 'tg-chat-title' },
                    h('span', { className: 'tg-chat-name' }, it.name || it.chatId),
                    h('span', { className: 'tg-chat-id' }, it.chatId),
                    it.pendingCount > 0 && h('span', {
                      style: {
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        background: 'rgba(37,99,235,0.1)',
                        color: 'var(--ab-accent, #2563eb)',
                        fontWeight: 600
                      }
                    }, `📌 ${it.pendingCount} 条未结事项`),
                    inModCooldown && h('span', {
                      style: {
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        background: 'rgba(245,158,11,0.12)',
                        color: 'var(--ab-warn, #b45309)',
                        fontWeight: 600
                      }
                    }, `🛡️ 审核冷却中 (${Math.ceil(it.moderationRemainSec / 60)}分)`)
                  ),
                  h('div', { className: 'tg-chat-actions' },
                    it.hasSummary && h(Btn, {
                      small: true,
                      disabled: isLoadingSum,
                      onClick: () => toggleSummary(it.chatId)
                    }, isLoadingSum ? '读取中…' : (summaryData ? '收起摘要' : '📄 查看摘要')),
                    h(Btn, {
                      small: true,
                      kind: isOver ? 'primary' : 'default',
                      disabled: busyChat === it.chatId || it.busy,
                      onClick: () => handleCompact(it.chatId)
                    }, (busyChat === it.chatId || it.busy) ? '压缩中…' : '现在压一次')
                  )
                ),

                // 进度条
                h('div', { className: 'tg-progress-bar' },
                  h('div', {
                    className: 'tg-progress-fill',
                    style: { width: pct + '%', background: progressColor }
                  })
                ),

                // 底部元信息
                h('div', { className: 'tg-chat-meta' },
                  h('span', null,
                    h('b', { style: { color: isOver ? '#ef4444' : 'inherit' } }, fmt(it.tokens)),
                    ` / ${fmt(threshold)} token `,
                    h('span', { className: 'ab-muted' }, `(${pct}% · ${it.estimated ? '字符估算' : '真实用量'})`)
                  ),
                  h('span', null,
                    `已压缩 ${it.compacts} 次`,
                    it.lastCompactAt ? ` · 上次压缩 ${ago(it.lastCompactAt)}` : ' · 尚未压缩',
                    ` · 上次发言 ${ago(it.lastAt)}`
                  )
                ),

                // 异常与报警提示条
                it.failures > 0 && h('div', {
                  className: 'ab-note' + (inModCooldown ? '' : ' err'),
                  style: { marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
                },
                  h('span', null,
                    inModCooldown
                      ? `⚠️ 该聊天流水触发了模型厂商的内容审核拦截（${it.lastError.slice(0, 70)}），系统已自动开启安全规避冷却。`
                      : `连续失败 ${it.failures} 次：${it.lastError || '未知原因'}`
                  ),
                  h(Btn, {
                    small: true,
                    title: '清空异常暴涨的字符数，解除重试阻断',
                    onClick: () => handleResetUsage(it.chatId)
                  }, '🧹 重置计数')
                ),

                // 展开的结构化摘要详情抽屉
                summaryData && h('div', { className: 'tg-summary-box' },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ab-sub, #6b7280)' } },
                    h('b', null, '📋 当前生效的检查点摘要：'),
                    h('span', null, `生成于 ${new Date(summaryData.at).toLocaleString('zh-CN')} (${summaryData.text.length}字)`)
                  ),
                  h('div', { className: 'tg-summary-text' }, summaryData.text),
                  summaryData.structured && h('div', { className: 'tg-struct-grid' },
                    summaryData.structured.topics?.length > 0 && h('div', { className: 'tg-struct-item' },
                      h('span', { className: 'tg-struct-tag' }, '【话题】'),
                      h('span', null, summaryData.structured.topics.join('；'))
                    ),
                    summaryData.structured.background?.length > 0 && h('div', { className: 'tg-struct-item' },
                      h('span', { className: 'tg-struct-tag' }, '【背景】'),
                      h('span', null, summaryData.structured.background.join('；'))
                    ),
                    summaryData.structured.progress?.length > 0 && h('div', { className: 'tg-struct-item' },
                      h('span', { className: 'tg-struct-tag' }, '【进展】'),
                      h('span', null, summaryData.structured.progress.join('；'))
                    ),
                    summaryData.structured.pending?.length > 0 && h('div', { className: 'tg-struct-item' },
                      h('span', { className: 'tg-struct-tag', style: { color: 'var(--ab-warn, #b45309)' } }, '【待办/未结】'),
                      h('span', { style: { fontWeight: 500 } }, summaryData.structured.pending.join('；'))
                    ),
                    summaryData.structured.agreements?.length > 0 && h('div', { className: 'tg-struct-item' },
                      h('span', { className: 'tg-struct-tag', style: { color: '#059669' } }, '【约定】'),
                      h('span', null, summaryData.structured.agreements.join('；'))
                    )
                  )
                )
              )
            })
          )
    )
  )
}
