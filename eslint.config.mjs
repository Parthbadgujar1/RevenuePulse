import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',
      '**/generated/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.ts',
      '**/*.tsx',
      '**/*.d.ts',
      'services/ml/**',
      'eslint.config.mjs',
      'scripts/**',
      'prisma/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: {
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
];