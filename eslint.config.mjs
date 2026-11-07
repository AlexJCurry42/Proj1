// Project Planetarium — lint policy. Deliberately small and dependency-free
// (core ESLint rules only, no plugins): every rule here is a SECURITY or
// correctness invariant the codebase actually holds, enforced in CI
// (.github/workflows/lint.yml). Style is left to code review.
export default [
  // Global ignore: vendored upstream code is linted upstream, and its
  // inline eslint directives reference plugins this config doesn't load.
  { ignores: ['js/vendor/**', 'tests/browser/.cache/**'] },
  {
    files: ['js/**/*.js', 'tests/**/*.mjs', 'sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module'
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      // The no-dynamic-code family: the app's XSS posture depends on it.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      // Long-settled project invariants.
      'no-var': 'error',
      'no-with': 'error'
    }
  }
];
