import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Build output / framework codegen — anywhere in the tree, not just root,
    // so the nested docs-site app is covered too. Flat config does NOT read
    // .gitignore, so these must be listed explicitly.
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/dist/**",
    "**/.source/**", // Fumadocs generated source map (docs-site/.source)
    "**/next-env.d.ts",
    // Local agent state + ephemeral git worktrees (full repo copies — never
    // lint them; they double-count every real file).
    ".claude/**",
  ]),
  // The React Compiler readiness rules (eslint-plugin-react-hooks v6) are
  // advisory, not correctness bugs — they fire on ordinary data-fetch-on-mount
  // effects and on non-React scripts. Keep them VISIBLE as warnings rather than
  // blocking the gate. `rules-of-hooks` and `exhaustive-deps` keep their
  // default (error) severity, since those catch real bugs.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      // Allow intentionally-unused bindings when prefixed with `_` (the common
      // convention for "I know this is unused" — e.g. destructure-to-discard).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Node scripts and test files aren't React components and legitimately log to
  // the console — don't apply the React Compiler rules or no-console there.
  {
    files: ["scripts/**", "test/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-console": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
    },
  },
]);

export default eslintConfig;
