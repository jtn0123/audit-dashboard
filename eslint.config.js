const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['log', 'warn'] }],
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'no-empty': 'off',
    },
  },
  {
    files: ['server.js', 'eslint.config.js', 'tests/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        marked: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: ['node_modules/'],
  },
];
