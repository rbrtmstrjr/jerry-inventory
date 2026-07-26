"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  Loader2,
  Search,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAGE_SIZES } from "./table-params";

/** Long enough to finish a word before the server round-trip fires; Enter
 *  searches immediately for anyone who does not want to wait. */
const SEARCH_DEBOUNCE_MS = 600;
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * SERVER-SIDE data table — the scalable twin of <DataTable>.
 *
 * <DataTable> pulls every row into the browser and paginates there, so its cost
 * grows with the size of the table (fine for a few hundred rows, fatal at tens
 * of thousands). This one renders ONE PAGE that the server already sliced:
 * pagination, sorting and search live in the URL, the page's server component
 * reads them and issues a bounded `.range()` query. Cost is O(page size), not
 * O(total rows) — it reads the same whether the table holds 6k rows or 6M.
 *
 * URL is the single source of truth (same idea as the Movements journal), so a
 * filtered page is shareable, bookmarkable, survives refresh, and re-suspends
 * through the page's existing skeleton. Params owned here: page · size · sort ·
 * dir · q. Every OTHER param is preserved, so a page's own filters/tabs coexist.
 *
 * Columns are plain `ColumnDef`s — the same objects <DataTable> takes — so
 * converting a page is mostly swapping the component and moving the query.
 */

/** Read/merge the params this table owns, preserving everything else. */
function useTableNav() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const push = React.useCallback(
    (next: Record<string, string | number | null>) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === "") p.delete(k);
        else p.set(k, String(v));
      }
      const qs = p.toString();
      startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
    },
    [router, pathname, searchParams]
  );

  return { push, pending };
}

interface ServerDataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  /** ONE page of rows, already sliced by the server. */
  data: TData[];
  /** Total rows matching the current filters (server `count: "exact"`). */
  total: number;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Current search text (drives the `q` param). Omit to hide the search box. */
  searchPlaceholder?: string;
  q?: string;
  filters?: React.ReactNode;
  toolbar?: React.ReactNode;
  emptyMessage?: string;
  rowClassName?: (row: TData) => string | undefined;
}

export function ServerDataTable<TData, TValue>({
  columns,
  data,
  total,
  page,
  pageSize,
  searchPlaceholder,
  q = "",
  filters,
  toolbar,
  emptyMessage = "No records yet.",
  rowClassName,
}: ServerDataTableProps<TData, TValue>) {
  const { push, pending } = useTableNav();
  const [term, setTerm] = React.useState(q);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the box in sync when the URL changes underneath (back/forward, reset).
  React.useEffect(() => setTerm(q), [q]);

  /** Debounced so typing doesn't fire a server round-trip per keystroke. */
  function onSearchChange(val: string) {
    setTerm(val);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push({ q: val || null, page: null }), SEARCH_DEBOUNCE_MS);
  }

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: total,
  });

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-3">
      {(searchPlaceholder || filters || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder && (
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  // Enter = search now, don't wait out the debounce
                  if (e.key === "Enter") {
                    if (timer.current) clearTimeout(timer.current);
                    push({ q: term || null, page: null });
                  }
                }}
                placeholder={searchPlaceholder}
                className="pl-8"
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          {filters}
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </div>
      )}

      {/* Only the rows scroll — toolbar above and pagination below stay put.
          `pending` dims the slice while the next page streams in, so a server
          round-trip reads as loading instead of an unexplained pause. */}
      <div className="thin-scrollbar relative max-h-[65vh] overflow-auto rounded-md border">
        {pending && (
          <div className="pointer-events-none absolute right-3 top-3 z-20">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <Table className={cn(pending && "opacity-60 transition-opacity")}>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-b-0">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className={rowClassName?.(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-10">
                  <Empty className="border-0 p-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Inbox />
                      </EmptyMedia>
                      <EmptyDescription>
                        {q ? `Nothing matches “${q}”.` : emptyMessage}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground tabular-nums">
          {firstRow}–{lastRow} of {total.toLocaleString()}
        </p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Rows</span>
            <Select
              value={String(pageSize)}
              // changing page size keeps you near the top — page 7 of 20 is not
              // page 7 of 100, so reset rather than land somewhere arbitrary
              onValueChange={(v) => push({ size: v, page: null })}
            >
              <SelectTrigger size="sm" className="w-18" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="First page"
              disabled={page <= 1 || pending}
              onClick={() => push({ page: null })}
            >
              <ChevronsLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page <= 1 || pending}
              onClick={() => push({ page: page - 1 <= 1 ? null : page - 1 })}
            >
              <ChevronLeft />
            </Button>
            <span className="px-2 text-xs text-muted-foreground tabular-nums">
              Page {page} of {lastPage}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={page >= lastPage || pending}
              onClick={() => push({ page: page + 1 })}
            >
              <ChevronRight />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Last page"
              disabled={page >= lastPage || pending}
              onClick={() => push({ page: lastPage })}
            >
              <ChevronsRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sortable header for a server-sorted table — same look as <SortableHeader>,
 * but it writes `sort`/`dir` to the URL instead of sorting rows in the browser.
 * Self-contained (reads the URL itself) so column defs stay plain objects.
 */
export function ServerSortableHeader({
  column,
  children,
  className,
}: {
  /** Column id as the server understands it (the DB column to ORDER BY). */
  column: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { push } = useTableNav();
  const searchParams = useSearchParams();
  const active = searchParams.get("sort") === column;
  const dir = active ? (searchParams.get("dir") === "desc" ? "desc" : "asc") : null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 h-8 gap-1", className)}
      // first click sorts ascending, second flips — a new sort always starts
      // from page 1, since page 3 of a different order is meaningless
      onClick={() =>
        push({ sort: column, dir: dir === "asc" ? "desc" : "asc", page: null })
      }
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      {children}
      {dir === "asc" ? (
        <ArrowUp className="size-3.5" />
      ) : dir === "desc" ? (
        <ArrowDown className="size-3.5" />
      ) : (
        <ArrowUpDown className="size-3.5 opacity-50" />
      )}
    </Button>
  );
}

/**
 * Search box wired to the URL `q` param (debounced), for views that aren't a
 * table — e.g. the product/engine CARD grids, which need the same server-side
 * search as their table twin so results aren't limited to the current page.
 */
export function ServerSearchInput({
  q = "",
  placeholder,
  className,
}: {
  q?: string;
  placeholder: string;
  className?: string;
}) {
  const { push } = useTableNav();
  const [term, setTerm] = React.useState(q);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => setTerm(q), [q]);

  return (
    <div className={cn("relative w-full max-w-xs", className)}>
      <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const val = e.target.value;
          timer.current = setTimeout(() => push({ q: val || null, page: null }), SEARCH_DEBOUNCE_MS);
        }}
        onKeyDown={(e) => {
          // Enter = search now, don't wait out the debounce
          if (e.key === "Enter") {
            if (timer.current) clearTimeout(timer.current);
            push({ q: term || null, page: null });
          }
        }}
        placeholder={placeholder}
        className="pl-8"
        aria-label={placeholder}
      />
    </div>
  );
}

/** Pager for non-table views (card grids) — same URL params as the table. */
export function ServerPaginationBar({
  total,
  page,
  pageSize,
  noun = "items",
}: {
  total: number;
  page: number;
  pageSize: number;
  noun?: string;
}) {
  const { push, pending } = useTableNav();
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {firstRow}–{lastRow} of {total.toLocaleString()} {noun}
      </p>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows</span>
          <Select value={String(pageSize)} onValueChange={(v) => push({ size: v, page: null })}>
            <SelectTrigger size="sm" className="w-18" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1 || pending}
            onClick={() => push({ page: page - 1 <= 1 ? null : page - 1 })}
          >
            <ChevronLeft />
          </Button>
          <span className="px-2 text-xs text-muted-foreground tabular-nums">
            Page {page} of {lastPage}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= lastPage || pending}
            onClick={() => push({ page: page + 1 })}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
