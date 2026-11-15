import { h } from '../core/react.js'
import { Card } from '../ui/primitives.js'
import { cx } from '../core/utils.js'

// 「QQ 增强」页：把网关/QQ 版本提供的扩展能力收在一页。
// 说明如实：这些能力依赖网关实现（SnowLuma 已验证），不支持的动作应在日志里说明或优雅降级。
const CAPABILITIES = [
  { id: 'flash-transfer', name: '闪传', desc: '收发 QQ 闪传文件：看文件清单、下载到工作区、把收到的闪传转发给白名单会话。', need: '需要网关支持闪传相关动作' },
  { id: 'group-files', name: '群文件', desc: '浏览和下载群文件，必要时转存到工作区再处理。', need: '标准 OneBot 群文件接口' },
  { id: 'online-status', name: '在线与已读', desc: '查看对方在线状态与已读回执。', need: '需要网关支持在线状态扩展' },
  { id: 'social-actions', name: '社交动作', desc: '表情回应、设为精华、空间写扩展等社区动作。', need: '需要网关支持对应动作' },
  { id: 'ark-cards', name: 'Ark 卡片', desc: '发送分享、音乐、位置、联系人等结构化卡片消息。', need: '需要网关支持卡片段，不支持时降级文字' },
  { id: 'ai-voice', name: 'AI 语音', desc: 'QQ 官方 AI 变声：/变声 命令（群聊专用），零成本云端 TTS 备选；不接自动语音链。', need: '需要网关/QQ 支持 AI 变声接口' },
  { id: 'workspace-files', name: '工作区文件', desc: '写/读工作区里的文本文件（qq_write_file / qq_read_file）：先写成 txt/md/json，再配合群文件上传或闪传转发「写好发出去」。', need: '不依赖网关，本地工作区就能用' },
]

/** 网关能力概览页：模块自己的设置卡会自动排在下面（有 settings/panel 的模块）。 */
function Enhance({ st }) {
  const mods = st.modules || []
  const running = (id) => mods.some((m) => m.id === id && m.running)
  return (
    <div className="ab-grid">
      <Card
        title="QQ 增强"
        desc="这些是网关与 QQ 版本提供的扩展能力，加一个本地小工具：群文件、在线与已读、卡片、闪传、社交动作、AI 语音、工作区文件。部分动作只有部分网关实现（SnowLuma 已验证）；不支持的动作会在日志里说明或自动降级。"
        more={'下面每张卡是对应模块的设置；模块开关统一在「系统 → 扩展」里管理。某个能力没出现，说明对应模块没装或没在跑。'}
      >
        <div className="ab-list">
          {CAPABILITIES.map((c) => (
            <div key={c.id} className="ab-li">
              <div className="meta"><b>{c.name}</b></div>
              <div className="body">
                <div className="ab-small">{c.desc}</div>
                <div className="ab-small ab-muted" style={{ marginTop: 2 }}>{c.need}</div>
              </div>
              <span className={cx('ab-badge', !running(c.id) && 'dim')}>{running(c.id) ? '在跑' : '没在跑'}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export { Enhance, CAPABILITIES }
