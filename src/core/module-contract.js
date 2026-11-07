const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const CAPABILITY_RE = /^[a-z][a-z0-9-]{0,63}$/

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} 必须是正整数`)
}

function capabilities(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${field} 必须是能力字符串数组`)
  for (const item of value) {
    if (typeof item !== 'string' || !CAPABILITY_RE.test(item)) {
      throw new TypeError(`${field} 含非法能力名：${String(item)}`)
    }
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${field} 不能有重复能力`)
  return [...value]
}

export function validateModuleContract(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('模块定义必须是对象')
  }
  if (typeof definition.id !== 'string' || !ID_RE.test(definition.id)) {
    throw new TypeError(`模块 id「${definition.id ?? ''}」不符合现有模块 ID 规则`)
  }
  if (definition.version !== undefined && (typeof definition.version !== 'string' || definition.version.length === 0)) {
    throw new TypeError(`模块 ${definition.id} 的 version 必须是非空字符串`)
  }
  if (typeof definition.setup !== 'function') throw new TypeError(`模块 ${definition.id} 缺少 setup(api)`)

  const api = definition.api ?? 1
  const configVersion = definition.configVersion ?? 1
  const storageVersion = definition.storageVersion ?? 1
  positiveInteger(api, 'api')
  positiveInteger(configVersion, 'configVersion')
  positiveInteger(storageVersion, 'storageVersion')

  for (const field of ['defaultEnabled', 'requiresGUI']) {
    if (definition[field] !== undefined && typeof definition[field] !== 'boolean') {
      throw new TypeError(`${field} 必须是布尔值`)
    }
  }

  const provides = capabilities(definition.provides, 'provides')
  const requires = capabilities(definition.requires, 'requires')
  const conflicts = capabilities(definition.conflicts, 'conflicts')
  const provided = new Set(provides)
  for (const capability of requires) {
    if (provided.has(capability)) throw new TypeError(`模块 ${definition.id} 不能同时提供和依赖能力 ${capability}`)
  }
  for (const capability of conflicts) {
    if (capability === definition.id || provided.has(capability)) {
      throw new TypeError(`模块 ${definition.id} 不能与自身或自身能力 ${capability} 冲突`)
    }
  }

  return {
    ...definition,
    api,
    configVersion,
    storageVersion,
    provides,
    requires,
    conflicts,
  }
}
