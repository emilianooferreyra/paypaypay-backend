// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/require-await': 'warn',
      'no-empty': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Money is a bigint behind Money (ADR 0002). A decimal library must not
    // creep back into this codebase without a new decision.
    files: ['src/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/generated/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'decimal.js',
              message:
                'Do not import decimal.js. Money is a bigint fixed-point value object (docs/adr/0002-money-and-exact-decimals.md). Use Money, or Prisma.Decimal only at the persistence boundary.',
            },
          ],
        },
      ],
    },
  },
  {
    // Hexagonal boundary: the inner layers must not know the database exists.
    files: [
      'src/modules/wallet/domain/**/*.ts',
      'src/modules/wallet/application/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Flat config replaces, it does not merge: a file matched by this block
          // and by the decimal.js block above would lose one of the two rules.
          paths: [
            {
              name: 'decimal.js',
              message:
                'Do not import decimal.js. Money is a bigint fixed-point value object (docs/adr/0002-money-and-exact-decimals.md).',
            },
          ],
          patterns: [
            {
              group: [
                '**/generated/prisma',
                '**/generated/prisma/*',
                '@prisma/*',
                '**/prisma/prisma.service',
              ],
              message:
                'domain/ and application/ must not import Prisma. Depend on a port and implement it in infrastructure/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.spec.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
