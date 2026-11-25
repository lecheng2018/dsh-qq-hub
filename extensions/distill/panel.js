// modules/distill/panel.js
// 遵循 QQ Hub 原生面板规范与视觉系统，深度优化移动端窄屏触控与自适应排版
const { useState, useEffect } = React

const ago = (t) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? '刚刚' : m < 60 ? m + '分钟前' : Math.round(m / 60) + '小时前'
}

const STYLE_INJECTION = `
.distill-panel-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.distill-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--ab-surface, #f9fafb);
  border-radius: var(--ab-radius-sm, 6px);
  border: 1px solid var(--ab-line, #e5e7eb);
  font-size: 13px;
  flex-wrap: wrap;
}
.distill-meta-stats {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.distill-meta-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.distill-rule-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--ab-line, #e5e7eb);
  border-radius: var(--ab-radius-sm, 6px);
  background: var(--ab-card, #ffffff);
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  transition: border-color .15s, background .15s;
}
.distill-rule-item.locked {
  background: var(--ab-subtle-accent, rgba(37,99,235,0.04));
  border-color: color-mix(in srgb, var(--ab-sea, #0284c7) 38%, transparent);
}
.distill-rule-item.candidate {
  border-style: dashed;
  background: var(--ab-surface, #fafafa);
}
.distill-rule-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  border-top: 1px dashed var(--ab-line, #e5e7eb);
  padding-top: 8px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.distill-rule-btns {
  display: flex;
  gap: 6px;
  align-items: center;
}
.distill-form-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.distill-history-grid {
  display: flex;
  gap: 16px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.distill-history-grid .ab-row {
  border-top: 0;
  padding: 0;
}
@media (max-width: 720px) {
  .distill-meta-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding: 12px;
  }
  .distill-meta-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 12px;
  }
  .distill-meta-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    width: 100%;
  }
  .distill-meta-actions .ab-btn {
    width: 100%;
    justify-content: center;
  }
  .distill-history-grid {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .distill-history-grid > div:last-child {
    margin-left: 0 !important;
  }
  .distill-history-grid .ab-btn {
    width: 100%;
    justify-content: center;
  }
  .distill-form-row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .distill-form-row .ab-input,
  .distill-form-row .ab-btn {
    width: 100% !important;
  }
  .distill-rule-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .distill-rule-btns {
    justify-content: flex-end;
    width: 100%;
  }
  .distill-tab-btns {
    display: flex;
    width: 100%;
  }
  .distill-tab-btns .ab-btn {
    flex: 1;
    justify-content: center;
  }
}
`

return function DistillPanel({ toast }) {
  const { Card, Btn, Empty, Select, Row } = ui
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState([])
  const [selectedGroup, setSelectedGroup] = useState('')
  const [activeRules, setActiveRules] = useState([])
  const [candidateRules, setCandidateRules] = useState([])
  const [minCount, setMinCount] = useState(3)
  const [ruleTab, setRuleTab] = useState('active') // 'active' | 'candidates'

  // 历史提炼配置状态
  const [historyDays, setHistoryDays] = useState('3')
  const [sampleSize, setSampleSize] = useState('35')
  const [historyMining, setHistoryMining] = useState(false)

  // 模拟测试沙盒状态
  const [testInput, setTestInput] = useState('')
  const [simulating, setSimulating] = useState(false)
  const [simResult, setSimResult] = useState(null)

  // 手动新增表单状态
  const [newSit, setNewSit] = useState('')
  const [newStyle, setNewStyle] = useState('')
  const [adding, setAdding] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  const loadStatus = async () => {
    try {
      const res = await call('/status')
      if (res && res.ok) {
        setGroups(res.list || [])
        if (!selectedGroup && res.list.length > 0) {
          setSelectedGroup(res.list[0].groupId)
        }
      }
    } catch (e) {
      toast && toast('加载群状态失败', 'err')
    } finally {
      setLoading(false)
    }
  }

  const loadRules = async (gid) => {
    if (!gid) return
    try {
      const res = await call('/rules?groupId=' + encodeURIComponent(gid))
      if (res && res.ok) {
        setActiveRules(res.activeRules || [])
        setCandidateRules(res.candidateRules || [])
        setMinCount(res.minCount || 3)
      }
    } catch (e) {
      toast && toast('读取规则失败', 'err')
    }
  }

  useEffect(() => { loadStatus() }, [])
  useEffect(() => {
    if (selectedGroup) {
      loadRules(selectedGroup)
      setSimResult(null)
    }
  }, [selectedGroup])

  const handleToggleLock = async (ruleId) => {
    const res = await call('/toggle-lock', { groupId: selectedGroup, ruleId })
    if (res && res.ok) {
      await loadRules(selectedGroup)
      await loadStatus()
      toast && toast(res.locked ? '已锁定（防止自动淘汰）' : '已解锁')
    }
  }

  const handlePromote = async (ruleId) => {
    const res = await call('/promote', { groupId: selectedGroup, ruleId })
    if (res && res.ok) {
      await loadRules(selectedGroup)
      await loadStatus()
      toast && toast('已转正为正式生效规则！', 'ok')
    }
  }

  const handleDelete = async (ruleId) => {
    const res = await call('/delete-rule', { groupId: selectedGroup, ruleId })
    if (res && res.ok) {
      await loadRules(selectedGroup)
      await loadStatus()
      toast && toast('已删除')
    }
  }

  const handleAddManual = async () => {
    if (!newSit.trim() || !newStyle.trim()) {
      return toast && toast('情境和风格都必须填写', 'err')
    }
    setAdding(true)
    try {
      const res = await call('/add-manual', {
        groupId: selectedGroup,
        situation: newSit.trim(),
        style: newStyle.trim(),
      })
      if (res && res.ok) {
        toast && toast('成功添加并锁定规则', 'ok')
        setNewSit('')
        setNewStyle('')
        setRuleTab('active')
        await loadRules(selectedGroup)
        await loadStatus()
      } else {
        toast && toast(res.message || '添加失败', 'err')
      }
    } finally {
      setAdding(false)
    }
  }

  const handleTriggerRealtime = async () => {
    setTriggering(true)
    try {
      const res = await call('/trigger-now', { groupId: selectedGroup })
      if (res && res.ok) {
        toast && toast(res.message || '提炼完成')
        await loadRules(selectedGroup)
        await loadStatus()
      } else {
        toast && toast(res.message || '提炼未执行', 'err')
      }
    } finally {
      setTriggering(false)
    }
  }

  const handleDistillHistory = async () => {
    setHistoryMining(true)
    try {
      const res = await call('/distill-history', {
        groupId: selectedGroup,
        days: Number(historyDays) || 3,
        sampleSize: Number(sampleSize) || 35,
      })
      if (res && res.ok) {
        toast && toast(res.message || '历史提炼完成！', 'ok')
        await loadRules(selectedGroup)
        await loadStatus()
      } else {
        toast && toast(res.message || '提炼失败', 'err')
      }
    } catch (e) {
      toast && toast(e.message || '提炼请求异常', 'err')
    } finally {
      setHistoryMining(false)
    }
  }

  const handlePruneNoise = async () => {
    setActionBusy(true)
    try {
      const res = await call('/prune-noise', { groupId: selectedGroup })
      if (res && res.ok) {
        toast && toast(res.message || '清理完成！', 'ok')
        await loadRules(selectedGroup)
        await loadStatus()
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleConsolidate = async () => {
    setActionBusy(true)
    try {
      const res = await call('/consolidate', { groupId: selectedGroup })
      if (res && res.ok) {
        toast && toast(res.message || '聚类合并完成！', 'ok')
        await loadRules(selectedGroup)
        await loadStatus()
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleSimulate = async () => {
    if (!testInput.trim()) {
      return toast && toast('请输入模拟测试的发言内容', 'err')
    }
    setSimulating(true)
    try {
      const res = await call('/simulate', {
        groupId: selectedGroup,
        userText: testInput.trim(),
      })
      if (res && res.ok) {
        setSimResult(res)
      } else {
        toast && toast(res.message || '模拟测试失败', 'err')
      }
    } catch (e) {
      toast && toast(e.message || '模拟请求异常', 'err')
    } finally {
      setSimulating(false)
    }
  }

  if (loading) {
    return h(Card, { title: '群友蒸馏库' }, h(Empty, { icon: '⏳', text: '加载中…' }))
  }

  const curGroupInfo = groups.find(g => g.groupId === selectedGroup)

  return h('div', { className: 'distill-panel-root' },
    h('style', null, STYLE_INJECTION),

    // 顶部群选择与统计卡片
    h(Card, {
      title: '群友语感规则库',
      desc: '基于 MaiBot 核心设计哲学：高频口癖才升格生效，未命中情境绝不盲目强塞，保持 Bot 原生松弛感。'
    },
      groups.length === 0
        ? h(Empty, { icon: '💬', text: '本地暂无聊天记录，在群里聊几句或等待消息同步后出现。' })
        : h('div', null,
            h(Row, { label: '选择群聊' },
              h(Select, {
                value: selectedGroup,
                width: '100%',
                onChange: (val) => setSelectedGroup(val),
                options: groups.map(g => ({
                  value: g.groupId,
                  label: `${g.isLiveActive ? '🟢 [实时生效]' : '⚪ [未开启实时]'} ${g.groupName || g.groupId} (${g.groupId}) — 生效 ${g.activeCount || 0} 条`
                }))
              })
            ),
            curGroupInfo && h('div', { className: 'distill-meta-bar' },
              h('div', { style: { width: '100%', display: 'flex', alignItems: 'center', marginBottom: 2 } },
                curGroupInfo.isLiveActive
                  ? h('span', {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                        background: 'rgba(34, 197, 94, 0.12)',
                        color: 'var(--ab-success, #16a34a)',
                        border: '1px solid rgba(34, 197, 94, 0.25)'
                      }
                    }, '🟢 该群当前处于实时生效中（日常聊天自动缓冲提炼，并在回复时按需注入）')
                  : h('span', {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: 'var(--ab-surface, #f3f4f6)',
                        color: 'var(--ab-muted, #6b7280)',
                        border: '1px solid var(--ab-line, #e5e7eb)'
                      }
                    }, '⚪ 该群未开启实时生效（上方「指定生效群号」未包含此群；日常聊天不监听不注入，仅供查看与历史提炼）')
              ),
              h('div', { className: 'distill-meta-stats' },
                h('span', null, '🔥 生效：', h('b', { style: { color: 'var(--ab-accent, #2563eb)' } }, curGroupInfo.activeCount || 0)),
                h('span', null, '⏳ 候选：', h('b', null, curGroupInfo.candidateCount || 0)),
                h('span', null, '🔒 锁定：', h('b', null, curGroupInfo.lockedCount || 0)),
                h('span', null, '待提炼缓存：', h('b', null, curGroupInfo.bufferCount || 0))
              ),
              h('div', { className: 'distill-meta-actions' },
                h(Btn, {
                  small: true,
                  disabled: actionBusy,
                  title: '把已有近义的规则合并并累加出现频次',
                  onClick: handleConsolidate
                }, '🔗 聚类合并'),
                h(Btn, {
                  small: true,
                  disabled: actionBusy,
                  title: '删除只出现过 1 次的未锁定偶发噪点',
                  onClick: handlePruneNoise
                }, '🧹 清理噪点'),
                h(Btn, {
                  small: true,
                  disabled: triggering || historyMining,
                  onClick: handleTriggerRealtime
                }, triggering ? '提炼中…' : '提炼实时缓存')
              )
            )
          )
    ),

    // 从本地历史聊天记录批量提炼卡片
    selectedGroup && h(Card, {
      title: '从本地历史聊天记录提炼',
      desc: '利用本地 chatlog 留存的大量发言流水批量提炼，自动按语义合并同义口癖。'
    },
      h('div', { className: 'distill-history-grid' },
        h(Row, { label: '历史时段' },
          h(Select, {
            value: historyDays,
            width: 140,
            onChange: (val) => setHistoryDays(val),
            options: [
              { value: '1', label: '最近 1 天' },
              { value: '3', label: '最近 3 天' },
              { value: '7', label: '最近 7 天 / 全部' },
            ]
          })
        ),
        h(Row, { label: '抽样规模' },
          h(Select, {
            value: sampleSize,
            width: 140,
            onChange: (val) => setSampleSize(val),
            options: [
              { value: '25', label: '25 组精炼样本' },
              { value: '35', label: '35 组标准样本' },
              { value: '50', label: '50 组大样本' },
            ]
          })
        ),
        h('div', { style: { marginLeft: 'auto', marginBottom: 2 } },
          h(Btn, {
            kind: 'primary',
            disabled: historyMining || triggering || (curGroupInfo && curGroupInfo.historyCount < 5),
            onClick: handleDistillHistory
          }, historyMining ? '正在从历史记录提炼…' : '🚀 开始从历史提炼')
        )
      )
    ),

    // 模拟测试回复效果卡片（沙盒验证）
    selectedGroup && h(Card, {
      title: '🧪 模拟测试回复效果（沙盒测试）',
      desc: '输入一句群友发言，现场验证是否命中生效规则，以及未命中时是否保持正常人设不强加戏。'
    },
      h('div', { className: 'distill-form-row', style: { marginBottom: 12 } },
        h('input', {
          className: 'ab-input wide',
          placeholder: '输入你想测试的群友发言（例如：这次重构改动太大了 / 听说某某模型又刷榜了）',
          value: testInput,
          onChange: (e) => setTestInput(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') handleSimulate() }
        }),
        h(Btn, {
          disabled: simulating || !testInput.trim(),
          onClick: handleSimulate
        }, simulating ? '模拟中…' : '发送模拟测试')
      ),
      simResult && h('div', {
        style: {
          padding: '12px 14px',
          background: 'var(--ab-surface, #f9fafb)',
          borderRadius: 6,
          border: '1px solid var(--ab-line, #e5e7eb)',
          fontSize: 13,
          lineHeight: 1.6
        }
      },
        h('div', { style: { marginBottom: 8 } },
          h('span', { style: { fontWeight: 600 } }, '🎯 命中结果：'),
          simResult.hit && simResult.matchedRules && simResult.matchedRules.length > 0
            ? simResult.matchedRules.map(r => h('span', {
                key: r.id,
                style: {
                  display: 'inline-block',
                  margin: '2px 4px',
                  padding: '2px 8px',
                  background: 'var(--ab-subtle-accent, #eff6ff)',
                  color: 'var(--ab-accent, #2563eb)',
                  borderRadius: 4,
                  border: '1px solid var(--ab-accent-line, #bfdbfe)'
                }
              }, `当 ${r.situation.replace(/时$/, '')} 时：${r.style} (出现 ${r.count} 次)`))
            : h('span', { className: 'ab-muted' }, '🍃 未触发特定情境（严格不注入规则，Bot 保持原生性格自然回答，绝不尬梗）')
        ),
        simResult.stylePrompt && h('div', { style: { marginBottom: 8, color: 'var(--ab-muted, #6b7280)', fontSize: 12 } },
          h('b', null, '📝 注入的语感提示：'),
          h('span', null, simResult.stylePrompt)
        ),
        h('div', {
          style: {
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--ab-card, #ffffff)',
            borderRadius: 6,
            borderLeft: '4px solid ' + (simResult.hit ? 'var(--ab-accent, #2563eb)' : 'var(--ab-line, #9ca3af)')
          }
        },
          h('div', { style: { fontSize: 12, color: 'var(--ab-muted, #6b7280)', marginBottom: 4 } },
            simResult.hit ? '💬 Bot 注入群友口癖后的回复：' : '💬 Bot 原生回复（未带规则）：'
          ),
          h('div', { style: { fontSize: 14, whiteSpace: 'pre-wrap' } }, simResult.reply)
        )
      )
    ),

    // 规则库管理展示卡片（区分：正式生效库 vs 待观察候选池）
    selectedGroup && h(Card, {
      title: '群友语感规则管理',
      desc: `门槛机制：提炼出的规则初始处于观察池，群友累计使用 ≥${minCount} 次或手动点击【⭐ 转正】后才会实际生效。`
    },
      h('div', { className: 'distill-tab-btns', style: { gap: 8, marginBottom: 14 } },
        h(Btn, {
          small: true,
          kind: ruleTab === 'active' ? 'primary' : 'default',
          onClick: () => setRuleTab('active')
        }, `🔥 正式生效库 (${activeRules.length})`),
        h(Btn, {
          small: true,
          kind: ruleTab === 'candidates' ? 'primary' : 'default',
          onClick: () => setRuleTab('candidates')
        }, `⏳ 待观察候选池 (${candidateRules.length})`)
      ),

      ruleTab === 'active' ? (
        activeRules.length === 0
          ? h(Empty, { icon: '📭', text: '暂无正式生效规则。可以在观察池中挑选优质习惯点击「⭐ 转正」，或点击上方「从历史提炼」。' })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              activeRules.map(r => h('div', {
                key: r.id,
                className: 'distill-rule-item' + (r.locked ? ' locked' : '')
              },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: 13.5, marginBottom: 3 } },
                    '当 ', h('span', { style: { color: 'var(--ab-accent, #2563eb)' } }, r.situation.replace(/时$/, '')),
                    ' 时：'
                  ),
                  h('div', { style: { fontSize: 13, color: 'var(--ab-text, #111827)' } }, r.style)
                ),
                h('div', { className: 'distill-rule-footer' },
                  h('span', { className: 'ab-muted' },
                    `群友使用 ${r.count || 1} 次${r.injectedCount ? ` · 已注入 ${r.injectedCount} 次` : ''}${r.lastInjectedAt ? ` (${ago(r.lastInjectedAt)})` : ''}`
                  ),
                  h('div', { className: 'distill-rule-btns' },
                    h(Btn, {
                      small: true,
                      onClick: () => handleToggleLock(r.id)
                    }, r.locked ? '🔒 已锁' : '🔓 锁定'),
                    h(Btn, {
                      small: true,
                      onClick: () => handleDelete(r.id)
                    }, '删除')
                  )
                )
              ))
            )
      ) : (
        candidateRules.length === 0
          ? h(Empty, { icon: '🍃', text: '观察池暂无待沉淀规则，群聊产生新表达后会首先进入此处。' })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h('div', { className: 'ab-note', style: { marginBottom: 6 } },
                `以下为群友单次或偶发表达。群友再次使用满 ${minCount} 次自动升格生效；你也可以点击【⭐ 转正】直接启用。`
              ),
              candidateRules.map(r => h('div', {
                key: r.id,
                className: 'distill-rule-item candidate'
              },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: 13.5, marginBottom: 3 } },
                    '当 ', h('span', { style: { color: 'var(--ab-text-secondary, #4b5563)' } }, r.situation.replace(/时$/, '')),
                    ' 时：'
                  ),
                  h('div', { style: { fontSize: 13, color: 'var(--ab-text, #111827)' } }, r.style)
                ),
                h('div', { className: 'distill-rule-footer' },
                  h('span', { style: { color: 'var(--ab-warn, #b45309)' } },
                    `群友仅使用 ${r.count || 1} / ${minCount} 次（观察中）`
                  ),
                  h('div', { className: 'distill-rule-btns' },
                    h(Btn, {
                      small: true,
                      kind: 'primary',
                      title: '手动将此表达转正为正式生效规则',
                      onClick: () => handlePromote(r.id)
                    }, '⭐ 转正并锁定'),
                    h(Btn, {
                      small: true,
                      onClick: () => handleDelete(r.id)
                    }, '丢弃')
                  )
                )
              ))
            )
      )
    ),

    // 手工录入卡片
    selectedGroup && h(Card, {
      title: '手动录入群梗/口癖',
      desc: '如果你想让 Bot 快速学会群里的某个特定梗或说话习惯，可以直接在此录入（直接转正生效并锁定）。'
    },
      h('div', { className: 'distill-form-row' },
        h('input', {
          className: 'ab-input wide',
          placeholder: '适用情境（如：聊到抽卡爆死时）',
          value: newSit,
          onChange: (e) => setNewSit(e.target.value)
        }),
        h('input', {
          className: 'ab-input wide',
          placeholder: '表达习惯（如：使用“好似开香槟咯”）',
          value: newStyle,
          onChange: (e) => setNewStyle(e.target.value)
        }),
        h(Btn, {
          disabled: adding,
          onClick: handleAddManual
        }, adding ? '添加中…' : '添加并转正')
      )
    )
  )
}
