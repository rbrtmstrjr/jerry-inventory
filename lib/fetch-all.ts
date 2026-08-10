/** Neutral home for the row-cap paging helpers. The direction looks backwards on
 *  purpose — test-pnl loads pnl.ts with bare Node, so it must stay import-free. */
export { fetchAll, fetchAllOffset } from "./pnl";
