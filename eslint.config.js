import globals from 'globals'

export default [
  {
    ignores: [
      'src/modules/**/panel.js',
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
]
