// Flat config, carried over from the cognium-dev monorepo this package came
// from. Deliberately narrow: type-checking is already enforced by
// `npm run typecheck` in strict mode, and formatting is not enforced at all —
// neither is duplicated here.
//
// What is enabled is the correctness subset: things tsc does not catch
// (atomic-update races, unreachable or unmodified loops, accidental
// fallthrough, self-compare).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `--fix` otherwise deletes eslint-disable comments for rules this config
    // leaves off (no-console, say). Those comments document intent and matter
    // the moment a rule is switched back on, so they are not churn to remove.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Code the tests analyse, not code this repo runs: it is deliberately
      // vulnerable and in whatever style the case needs.
      '**/tests/fixtures/**/project/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc in strict mode already covers unused locals/params, and the
      // no-explicit-any blanket ban would fire on the handlers' deliberately
      // loose IR boundaries. Both are noise here.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',

      // tsc resolves globals and module scope; eslint's core rule does not
      // understand TS and reports false positives on type-only and ambient
      // names. typescript-eslint documents turning it off for TS sources.
      'no-undef': 'off',

      // Cosmetic: ESLint itself declines to auto-fix this rule because
      // dropping an escape can change a pattern's intent.
      'no-useless-escape': 'off',

      // Correctness rules worth failing a build over.
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'require-atomic-updates': 'error',
    },
  },
  {
    // Tests exercise error paths and throwaway shapes; the recommended set
    // fights that without catching real defects.
    files: ['**/tests/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
);
