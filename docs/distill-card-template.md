# 蒸馏语感卡模板 v1（内置，可在面板查看；卡片生成时 {{distill}} 替换为蒸馏数据段）
#
# 结构（业界蒸馏/角色卡做法，改动请同步 test/distill-card.test.js）：
#   {{distill}} 展开为：
#     【语感·借自「<名字>」】
#     ── 对话方式 ──            ← exchanges（怎么接话，最重要）
#     ── 句子与用词 ──          ← syntax + catchphrases + rhetoric
#     ── 他绝不会 ──            ← never
#     ── 他是谁 / 性格 ──       ← identity + persona
#     （只借说话方式，不借身份边界句）
#
# 占位符在 distill-card.js 的 TEMPLATE_BLOCK 里定义，数据段由 profile 字段按序渲染。

以下是模板正文示例（生成派生卡时，底卡正文 + 下面的借用段）：

【从群友身上借来的说话方式】

{{distill}}

（说明：以上内容从群友真实发言蒸馏而来，只借说话的方式与节奏；不借身份，不提及来源个人隐私。）
