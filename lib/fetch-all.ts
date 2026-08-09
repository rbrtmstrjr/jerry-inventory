/**
 * The neutral home for the row-cap paging helpers, so a stock or catalog screen
 * can page its reads without importing the P&L module.
 *
 * THE DEPENDENCY DIRECTION LOOKS BACKWARDS ON PURPOSE — do not "fix" it
 * by moving the bodies here and having pnl.ts import them. `scripts/test-pnl.mjs`
 * loads `lib/pnl.ts` with BARE NODE (type-stripping, no bundler, no path
 * aliases), which cannot resolve an extensionless relative specifier. The
 * moment pnl.ts gains `import ... from "./fetch-all"` that suite dies with
 * ERR_MODULE_NOT_FOUND — which is exactly how this arrangement was arrived at.
 *
 * So: pnl.ts stays import-free and owns the code; this file re-exports it.
 * One implementation, and `npm test` still runs.
 */
export { fetchAll, fetchAllOffset } from "./pnl";
