export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        AbortController: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        m: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['public/admin.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        $: 'readonly',
        ajaxify: 'readonly',
        define: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];
