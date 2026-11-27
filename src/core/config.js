// 插件配置：文件读写入口 + 薄门面（拆分后的实现见 config-defaults / config-secrets / config-migrations / config-normalizers）。
//
// 本文件只保留「文件路径与读写」职责，所有归一化/迁移/脱敏逻辑已按职责拆到 4 个子模块。
// 对外导出 100% 兼容：所有历史 import { xxx } from '../core/config.js' 的调用方零破坏。

import { dataDir, readJson, writeJson } from './store.js'
import { migrateRawOnLoad } from './config-migrations.js'
import { normalize } from './config-normalizers.js'

// ---------------- 文件路径与读写 ----------------

function FILE() { return dataDir('config.json') }

/** 读磁盘配置（老配置先做一次性迁移再归一化）。 */
export function loadConfig() {
  const raw = migrateRawOnLoad(readJson(FILE(), () => ({})) || {})
  return normalize(raw)
}

/** 归一化后落盘（明文含密钥，权限收紧到 0600）。 */
export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c, { mode: 0o600 })
  return c
}

// ---------------- 薄门面 re-export ----------------

export {
  CONFIG_VERSION,
  DEFAULTS,
  OPT_IN_ON_UPDATE,
  GROUP_BUDGET_VERSION,
  deepFreeze,
  isObj,
  deepMerge,
} from './config-defaults.js'

export {
  registerSecretField,
  cookieValue,
  splitBiliCookie,
  publicConfig,
} from './config-secrets.js'

export {
  normalize,
  mergeFromPanel,
} from './config-normalizers.js'
