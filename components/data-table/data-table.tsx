"use client";

import * as React from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
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
  Search,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** placeholder for the global search box; omit to hide search */
  searchPlaceholder?: string;
  /** rendered immediately beside the search box (e.g. a filter dropdown) */
  filters?: React.ReactNode;
  /** rendered on the right of the toolbar (e.g. an "Add" button) */
  toolbar?: React.ReactNode;
  emptyMessage?: string;
  /** optional row highlighting, e.g. low-stock rows */
  rowClassName?: (row: TData) => string | undefined;
  /** initial rows per page (default 20) */
  pageSize?: number;
  /** enable a leading checkbox column for row selection. Provide getRowId for
   *  stable keys and onSelectedChange to receive the selected originals. */
  enableSelection?: boolean;
  getRowId?: (row: TData) => string;
  onSelectedChange?: (rows: TData[]) => void;
}

const PAGE_SIZES = [10, 20, 50, 100];

export function DataTable<TData, TValue>({
  columns,
  data,
  searchPlaceholder,
  filters,
  toolbar,
  emptyMessage = "No records yet.",
  rowClassName,
  pageSize = 20,
  enableSelection = false,
  getRowId,
  onSelectedChange,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [rowSelection, setRowSelection] = React.useState({});

  const allColumns = React.useMemo<ColumnDef<TData, TValue>[]>(() => {
    if (!enableSelection) return columns;
    const selectCol: ColumnDef<TData, TValue> = {
      id: "__select",
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() ? "indeterminate" : false)
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          aria-label="Select all on this page"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
          aria-label="Select row"
          onClick={(e) => e.stopPropagation()}
        />
      ),
    };
    return [selectCol, ...columns];
  }, [enableSelection, columns]);

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, globalFilter, rowSelection },
    initialState: { pagination: { pageSize } },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: enableSelection,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: "includesString",
    autoResetPageIndex: true,
  });

  // Bridge the selection to the parent. Depends only on rowSelection so an
  // inline onSelectedChange doesn't re-fire every render.
  React.useEffect(() => {
    if (onSelectedChange) {
      onSelectedChange(table.getSelectedRowModel().rows.map((r) => r.original));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection]);

  const filteredCount = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize: currentPageSize } = table.getState().pagination;
  const pageCount = table.getPageCount();
  const rangeStart = filteredCount === 0 ? 0 : pageIndex * currentPageSize + 1;
  const rangeEnd = Math.min(filteredCount, (pageIndex + 1) * currentPageSize);

  return (
    <div className="flex flex-col gap-3">
      {(searchPlaceholder || filters || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder && (
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
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

      {/* Only the rows scroll — toolbar above and pagination below stay in place */}
      <div className="thin-scrollbar max-h-[65vh] overflow-auto rounded-md border">
        <Table>
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
                <TableCell colSpan={allColumns.length} className="py-10">
                  <Empty className="border-0 p-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Inbox />
                      </EmptyMedia>
                      <EmptyDescription>
                        {globalFilter
                          ? `Nothing matches “${globalFilter}”.`
                          : emptyMessage}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination bar — hidden while everything fits on one page of 10 */}
      {(filteredCount > PAGE_SIZES[0] || pageCount > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            {rangeStart}–{rangeEnd} of {filteredCount}
            {filteredCount !== data.length && ` (filtered from ${data.length})`}
          </p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Rows</span>
              <Select
                value={String(currentPageSize)}
                onValueChange={(v) => table.setPageSize(Number(v))}
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
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.setPageIndex(0)}
              >
                <ChevronsLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
              >
                <ChevronLeft />
              </Button>
              <span className="px-2 text-xs text-muted-foreground tabular-nums">
                Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
              >
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Last page"
                disabled={!table.getCanNextPage()}
                onClick={() => table.setPageIndex(pageCount - 1)}
              >
                <ChevronsRight />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Sortable column header button */
export function SortableHeader({
  column,
  children,
  className,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column: any;
  children: React.ReactNode;
  className?: string;
}) {
  const dir = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 h-8 gap-1", className)}
      onClick={() => column.toggleSorting(dir === "asc")}
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
