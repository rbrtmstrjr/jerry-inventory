import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React Compiler advisory rules → warn, not error.
    //
    // eslint-config-next 16 ships the new React Compiler `react-hooks/*`
    // ruleset at `error`. These are OPTIMIZATION advisories, not correctness
    // bugs, and they flag idiomatic patterns this app uses correctly:
    //   • set-state-in-effect — localStorage hydration (can't read during SSR)
    //     and reset-dialog-on-open, both canonical.
    //   • preserve-manual-memoization — the compiler couldn't keep a hand-written
    //     useMemo; the memo still works, it just isn't compiler-optimized.
    // They do not gate `next build`. Downgrading to `warn` keeps them visible
    // without treating advisory hints as blocking errors — and keeps genuine
    // rules (exhaustive-deps, rules-of-hooks, refs) at their default severity,
    // so a real violation still surfaces. See audit Phase 0.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
