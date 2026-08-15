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
    files: ['server.js', 'eslint.config.js', 'lib/**/*.js', 'tests/**/*.js', 'mcp/**/*.js'],
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
        // Classic scripts share one global scope: app.js defines the helpers,
        // repos.js and insights.js define the views the router dispatches to.
        $: 'readonly',
        app: 'readonly',
        charts: 'writable',
        destroyCharts: 'readonly',
        trackChart: 'readonly',
        api: 'readonly',
        esc: 'readonly',
        jsAttr: 'readonly',
        navigate: 'readonly',
        showError: 'readonly',
        showLoading: 'readonly',
        severityBadge: 'readonly',
        severityRank: 'readonly',
        renderSeverityBar: 'readonly',
        relTime: 'readonly',
        shortDate: 'readonly',
        plural: 'readonly',
        viewHeader: 'readonly',
        noteBanner: 'readonly',
        route: 'readonly',
        SEVERITY_ORDER: 'readonly',
        CHART_COLORS: 'readonly',
        CHART_BASE: 'readonly',
        // repos.js
        renderPatch: 'readonly',
        renderPrs: 'readonly',
        renderCoverage: 'readonly',
        renderSettings: 'readonly',
        renderSetupScreen: 'readonly',
        refreshGitHub: 'readonly',
        // insights.js
        renderPosture: 'readonly',
        renderTrends: 'readonly',
        renderHistory: 'readonly',
        renderFindings: 'readonly',
        renderCalendar: 'readonly',
        alertItem: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    // public/vendor holds third-party builds committed verbatim — see its README.
    ignores: ['node_modules/', 'public/vendor/'],
  },
];
