/** Table paging constants + searchParams parsing. NOT in server-data-table.tsx:
 *  that is "use client", and a server component cannot call a client export. */

export const PAGE_SIZES = [10, 20, 50, 100];

/** Parse the params the server table owns out of a page's searchParams. */
export function parseTableParams(
  sp: Record<string, string | string[] | undefined>,
  opts: {
    defaultSize?: number;
    defaultSort?: string;
    defaultDir?: "asc" | "desc";
    /** Sortable columns. A `?sort=` outside this list falls back to the
     *  default — the value reaches `.order()`, so never trust it raw. */
    sortable?: readonly string[];
  } = {}
) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const size = Number(one(sp.size));
  const page = Number(one(sp.page));
  const dir = one(sp.dir);
  const asked = one(sp.sort);
  const sort =
    asked && (!opts.sortable || opts.sortable.includes(asked))
      ? asked
      : opts.defaultSort || null;
  return {
    page: Number.isFinite(page) && page > 1 ? Math.floor(page) : 1,
    pageSize: PAGE_SIZES.includes(size) ? size : (opts.defaultSize ?? 20),
    sort,
    dir: (dir === "desc" ? "desc" : dir === "asc" ? "asc" : opts.defaultDir ?? "asc") as
      | "asc"
      | "desc",
    q: (one(sp.q) ?? "").trim(),
  };
}
