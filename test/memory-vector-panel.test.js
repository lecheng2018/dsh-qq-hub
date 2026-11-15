// 向量通道面板设置（1.4.4）：
// ① memory 模块 def 声明的 settings/defaults 完整性（面板「记忆」页自动渲染的字段）；
// ② memory-archive 的双源桥接语义 —— 面板 ext.memory.vector* 填了 url 就以面板为准，
//    否则回落 config.json 的 memory.embeddings（桥接闭包在 archive 里，这里按同一逻辑
//    组装后过 normalizeEmbeddingConfig 验证最终生效的通道配置）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import memoryModule from '../src/modules/memory/index.js'
import { normalizeEmbeddingConfig } from '../src/features/memory-vector.js'

// 与 memory-archive.js createVectorChannel.getConfig 里的桥接保持一致
function bridged(getConfig) {
  const c = getConfig()
  const ext = (c.ext && c.ext.memory) || {}
  if (String(ext.vectorUrl || '').trim()) {
    return { ...c, memory: { ...(c.memory || {}), embeddings: { enabled: ext.vectorEnabled === true, url: ext.vectorUrl, apiKey: ext.vectorApiKey || '', model: ext.vectorModel || '', dim: ext.vectorDim } } }
  }
  return c
}

test('memory 模块声明向量通道面板设置（switch/text/password/text/number 五项 + 默认值）', () => {
  const keys = (memoryModule.settings || []).map((s) => s.key)
  for (const k of ['vectorEnabled', 'vectorUrl', 'vectorApiKey', 'vectorModel', 'vectorDim']) {
    assert.ok(keys.includes(k), `settings 缺少字段 ${k}`)
    assert.ok(k in (memoryModule.defaults || {}), `defaults 缺少 ${k}`)
  }
  assert.equal((memoryModule.defaults || {}).vectorEnabled, false, '默认关闭')
  assert.equal((memoryModule.defaults || {}).vectorDim, 1024, 'bge-m3 维度')
  // password 类型触发自动密钥登记：面板不回显原文、留空保存不清空（modules.js registerSecretField）
  const apiKey = memoryModule.settings.find((s) => s.key === 'vectorApiKey')
  assert.equal(apiKey.type, 'password')
  const dim = memoryModule.settings.find((s) => s.key === 'vectorDim')
  assert.equal(dim.type, 'number')
})

test('桥接双源：面板填了 url 就以面板为准（enabled 开关生效）', () => {
  const panel = bridged(() => ({
    memory: { embeddings: { enabled: true, url: 'https://file.example.com/v1/embeddings', apiKey: 'fileKey', dim: 768 } },
    ext: { memory: { vectorEnabled: true, vectorUrl: 'https://panel.example.com/v1/embeddings', vectorApiKey: 'panelKey', vectorModel: 'BAAI/bge-m3', vectorDim: 1024 } },
  }))
  const cfg = normalizeEmbeddingConfig(panel.memory)
  assert.ok(cfg, '面板配置启用时通道可用')
  assert.equal(cfg.url, 'https://panel.example.com/v1/embeddings')
  assert.equal(cfg.apiKey, 'panelKey')
  assert.equal(cfg.dim, 1024)
})

test('桥接双源：面板开了开关但没填 url → 回落配置文件 memory.embeddings', () => {
  const c = bridged(() => ({
    memory: { embeddings: { enabled: true, url: 'https://file.example.com/v1/embeddings', apiKey: 'fileKey', model: 'text-embedding-3-small', dim: 1536 } },
    ext: { memory: { vectorEnabled: true, vectorUrl: '', vectorApiKey: '', vectorModel: '', vectorDim: 1024 } },
  }))
  const cfg = normalizeEmbeddingConfig(c.memory)
  assert.ok(cfg, '回落到文件配置')
  assert.equal(cfg.url, 'https://file.example.com/v1/embeddings')
  assert.equal(cfg.apiKey, 'fileKey')
  assert.equal(cfg.dim, 1536)
})

test('桥接双源：面板开关关着 → 通道不启用（即使文件配置开着）', () => {
  const panel = bridged(() => ({
    memory: { embeddings: { enabled: true, url: 'https://file.example.com/v1/embeddings', dim: 1536 } },
    ext: { memory: { vectorEnabled: false, vectorUrl: 'https://panel.example.com/v1/embeddings', vectorApiKey: '', vectorModel: '', vectorDim: 1024 } },
  }))
  assert.equal(normalizeEmbeddingConfig(panel.memory), null, '面板填了 url 时以面板 enabled=false 为准')
})
