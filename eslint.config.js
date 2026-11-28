import globals from 'globals'

// 面板脚本（src/modules/**/panel.js、extensions/**/panel.js）不是 ESM 模块：它们由
// client/src/views/modules.js 用 `new Function('React','h','ui','call', src)` 求值，
// 依赖的 React/h/ui/call 是注入进来的**只读全局**。以前整类文件被 ignores 掉，于是
// 里面 `toast` 未定义、变量名拼错这类错误要等运行时在主人面板上崩（T1.5 就是这么来的）。
// 现在它们纳入检查：语法/未定义符号照查，注入的四件套按只读全局登记。
const PANEL_FILES = ['src/modules/**/panel.js', 'extensions/**/panel.js']
const PANEL_GLOBALS = {
  React: 'readonly',
  h: 'readonly',
  ui: 'readonly',
  call: 'readonly',
}

export default [
  {
    ignores: [
      'client/client.js',
      '**/node_modules/**',
    ],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-empty': 'warn',
      'no-undef': 'error',
      'no-use-before-define': ['warn', { variables: true, functions: false, classes: false }],
    },
  },
  {
    // src 下的面板脚本：ESM 之外的浏览器侧求值，只保留 node globals 的常用项
    files: PANEL_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // 面板脚本的整份源码就是一个函数体：末尾 `return function XPanel() {...}`
      // 是 new Function 的返回值，不是模块级 return。开 globalReturn 才能这么解析。
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { ...globals.browser, ...PANEL_GLOBALS },
    },
    rules: {
      'no-empty': 'warn',
      'no-undef': 'error',
      'no-use-before-define': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-empty': 'warn',
      'no-undef': 'error',
      'no-use-before-define': ['warn', { variables: true, functions: false, classes: false }],
    },
  },
]
