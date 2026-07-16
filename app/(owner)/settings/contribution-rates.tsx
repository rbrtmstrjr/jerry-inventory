"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CalendarPlus,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import type {
  ContributionAgency,
  ContributionBasis,
  ContributionBracketRow,
  ResolvedContribution,
} from "@/lib/db-types";
import { AGENCY_LABEL, AGENCY_ORDER } from "@/lib/contributions";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { ph_today } from "@/lib/ph-date";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DatePicker } from "@/components/date-picker";
import {
  previewContribution,
  softDeleteContributionBracket,
  startNewCircular,
  upsertContributionBracket,
} from "./actions";

// ---------------------------------------------------------------------------
// RATES ARE DATA, NOT CODE.
//
// Nothing in this file may carry a rate, percentage, bracket, MSC, floor or
// ceiling as a literal — not as a form default, not as a placeholder, not as a
// validation bound. Every number on screen is read from `contribution_brackets`
// or typed by the owner. The only literals here are labels, prose, and the
// enum values the schema itself defines.
// ---------------------------------------------------------------------------

// Agency names and their payslip order come from lib/contributions — one
// source, shared with the payroll side, so the two can never drift.

const BASIS_LABEL: Record<ContributionBasis, string> = {
  msc_bracket: "MSC bracket",
  percent_of_salary: "% of salary",
  fixed: "Fixed amount",
};

/** How a row of this shape actually computes — stated plainly, because the
 *  three shapes are genuinely different and mixing them up misremits. */
const BASIS_EXPLAINER: Record<ContributionBasis, string> = {
  msc_bracket:
    "Salary picks the bracket; the percents then apply to that bracket's Monthly Salary Credit (MSC) — never to actual salary.",
  percent_of_salary:
    "The monthly basis is clamped to the row's floor and ceiling first, then the percents apply to the clamped figure.",
  fixed: "Flat peso amounts, whatever the salary.",
};

// ---------------------------------------------------------------------------
// Formatting. Money goes through the centavo helpers; percents never do —
// ee_percent/er_percent are numeric(6,3), not money.
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A percent, not money. Trailing zeros from numeric(6,3) are noise. */
function formatPercent(p: number): string {
  return `${Number(p)}%`;
}

function formatSalaryRange(min: number, max: number | null): string {
  if (min === 0 && max === null) return "Any salary";
  if (min === 0) return `Up to ${formatCentavos(max as number)}`;
  if (max === null) return `${formatCentavos(min)} and up`;
  return `${formatCentavos(min)} – ${formatCentavos(max)}`;
}

/**
 * What an MSC row's own numbers come to. Derived purely from the row in front
 * of you (percent × that row's MSC) — a scanning aid, not a second rules
 * engine. Payroll and the preview below both go through
 * fn_resolve_contribution instead.
 */
function amountFromMsc(msc: number, percent: number): number {
  return Math.round((msc * Number(percent)) / 100);
}

// ---------------------------------------------------------------------------
// A "rate set" = every row an agency has for one effective date range. This is
// the unit a circular actually changes, so it is the unit the UI shows: SSS's
// 61 rows are one set, not 61 unrelated records.
// ---------------------------------------------------------------------------

type SetStatus = "current" | "scheduled" | "past";

interface RateSet {
  key: string;
  effective_from: string;
  effective_to: string | null;
  status: SetStatus;
  source_ref: string | null;
  rows: ContributionBracketRow[];
}

function groupSets(rows: ContributionBracketRow[], today: string): RateSet[] {
  const map = new Map<string, RateSet>();
  for (const r of rows) {
    const key = `${r.effective_from}|${r.effective_to ?? ""}`;
    let set = map.get(key);
    if (!set) {
      set = {
        key,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
        status:
          r.effective_from > today
            ? "scheduled"
            : r.effective_to !== null && r.effective_to < today
              ? "past"
              : "current",
        source_ref: r.source_ref,
        rows: [],
      };
      map.set(key, set);
    }
    set.rows.push(r);
  }
  for (const set of map.values()) {
    set.rows.sort((a, b) => a.salary_min_centavos - b.salary_min_centavos);
  }
  // newest first — the set you are most likely to be looking for
  return [...map.values()].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
}

function setLabel(set: RateSet): string {
  const span =
    set.effective_to === null
      ? `from ${formatDate(set.effective_from)}`
      : `${formatDate(set.effective_from)} – ${formatDate(set.effective_to)}`;
  const prefix =
    set.status === "current" ? "Current · " : set.status === "scheduled" ? "Scheduled · " : "";
  return `${prefix}${span} · ${set.rows.length} ${set.rows.length === 1 ? "row" : "rows"}`;
}

// ===========================================================================
// The rate book
// ===========================================================================

export function ContributionRates({ brackets }: { brackets: ContributionBracketRow[] }) {
  const [agency, setAgency] = React.useState<ContributionAgency>(AGENCY_ORDER[0]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4" /> Contribution Rates
        </CardTitle>
        <CardDescription>
          The SSS, PhilHealth and Pag-IBIG rate book that payroll computes from.
          Rates are data, not code — when an agency issues a new circular you
          update it here, and nothing needs redeploying.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <TriangleAlert />
          <AlertTitle>Verify against current circulars</AlertTitle>
          <AlertDescription>
            Verify against current SSS / PhilHealth / Pag-IBIG circulars — this
            system computes, it does not certify compliance.
          </AlertDescription>
        </Alert>

        <Tabs value={agency} onValueChange={(v) => setAgency(v as ContributionAgency)}>
          <TabsList>
            {AGENCY_ORDER.map((a) => (
              <TabsTrigger key={a} value={a} className="gap-1.5">
                {AGENCY_LABEL[a]}
                <Badge variant="secondary" className="tabular-nums">
                  {brackets.filter((b) => b.agency === a).length}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
          {AGENCY_ORDER.map((a) => (
            <TabsContent key={a} value={a} className="pt-4">
              <AgencyPanel
                agency={a}
                label={AGENCY_LABEL[a]}
                rows={brackets.filter((b) => b.agency === a)}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One agency: pick a rate set, scan/search/page its rows, edit one, or issue a
// whole new circular.
// ---------------------------------------------------------------------------

function AgencyPanel({
  agency,
  label,
  rows,
}: {
  agency: ContributionAgency;
  label: string;
  rows: ContributionBracketRow[];
}) {
  const today = React.useMemo(() => ph_today(), []);
  const sets = React.useMemo(() => groupSets(rows, today), [rows, today]);

  // Derived, not stored: after a new circular the old key disappears and this
  // falls back to the newest set — which is the one the owner just created.
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const set = sets.find((s) => s.key === selectedKey) ?? sets[0] ?? null;

  const [editing, setEditing] = React.useState<ContributionBracketRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [circularOpen, setCircularOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ContributionBracketRow | null>(null);

  const bases = React.useMemo(
    () => [...new Set((set?.rows ?? []).map((r) => r.basis))],
    [set]
  );
  const mixedBases = bases.length > 1;
  const hasMsc = bases.includes("msc_bracket");
  const hasClamp = (set?.rows ?? []).some(
    (r) => r.basis_floor_centavos !== null || r.basis_ceiling_centavos !== null
  );

  const columns = React.useMemo<ColumnDef<ContributionBracketRow>[]>(() => {
    const cols: ColumnDef<ContributionBracketRow>[] = [
      {
        id: "salary",
        // The table's global filter matches the accessor's value, so it holds
        // both what the row LOOKS like ("₱18,250.00 – ₱18,749.99") and its raw
        // centavos — otherwise searching a 61-row SSS set for the figure you
        // can see on screen finds nothing. Sorting stays numeric below.
        accessorFn: (r) =>
          [
            formatSalaryRange(r.salary_min_centavos, r.salary_max_centavos),
            r.salary_min_centavos,
            r.salary_max_centavos ?? "",
            r.note ?? "",
          ].join(" "),
        header: ({ column }) => <SortableHeader column={column}>Monthly salary</SortableHeader>,
        sortingFn: (a, b) => a.original.salary_min_centavos - b.original.salary_min_centavos,
        cell: ({ row }) => (
          <div className="min-w-40">
            <span className="font-medium tabular-nums">
              {formatSalaryRange(row.original.salary_min_centavos, row.original.salary_max_centavos)}
            </span>
            {row.original.note && (
              <div className="text-xs text-muted-foreground">{row.original.note}</div>
            )}
          </div>
        ),
      },
    ];

    if (mixedBases) {
      cols.push({
        accessorKey: "basis",
        header: "Shape",
        cell: ({ getValue }) => (
          <Badge variant="outline">{BASIS_LABEL[getValue<ContributionBasis>()]}</Badge>
        ),
      });
    }

    if (hasMsc) {
      cols.push({
        id: "msc",
        // searchable as displayed and as raw centavos; sorted numerically
        accessorFn: (r) =>
          r.credited_salary_centavos === null
            ? ""
            : `${formatCentavos(r.credited_salary_centavos)} ${r.credited_salary_centavos}`,
        header: ({ column }) => <SortableHeader column={column}>MSC</SortableHeader>,
        sortingFn: (a, b) =>
          (a.original.credited_salary_centavos ?? 0) - (b.original.credited_salary_centavos ?? 0),
        cell: ({ row }) => {
          const msc = row.original.credited_salary_centavos;
          return msc === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="font-medium tabular-nums">{formatCentavos(msc)}</span>
          );
        },
      });
    }

    cols.push(
      {
        id: "ee",
        header: "Employee",
        cell: ({ row }) => <ShareCell row={row.original} side="ee" />,
      },
      {
        id: "er",
        header: "Employer",
        cell: ({ row }) => <ShareCell row={row.original} side="er" />,
      }
    );

    if (hasClamp) {
      cols.push({
        id: "clamp",
        header: "Basis clamp",
        cell: ({ row }) => {
          const { basis_floor_centavos: floor, basis_ceiling_centavos: ceil } = row.original;
          if (floor === null && ceil === null) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <div className="min-w-28 text-xs tabular-nums">
              {floor !== null && <div>Floor {formatCentavos(floor)}</div>}
              {ceil !== null && <div>Ceiling {formatCentavos(ceil)}</div>}
            </div>
          );
        },
      });
    }

    cols.push(
      {
        accessorKey: "source_ref",
        header: "Source",
        cell: ({ getValue }) => {
          const src = getValue<string | null>();
          return src ? (
            <span className="text-xs text-muted-foreground">{src}</span>
          ) : (
            <span className="text-xs text-warning-foreground">Not cited</span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Row actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(row.original)}>
                <Pencil className="size-4" /> Edit row
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                <Trash2 className="size-4" /> Remove row
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }
    );

    return cols;
  }, [mixedBases, hasMsc, hasClamp]);

  if (!set) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          No {label} rates yet. Add the first bracket from the agency&apos;s
          current circular — payroll raises an error rather than guessing when
          no row covers a salary.
        </p>
        <div>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Add row
          </Button>
        </div>
        <BracketDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          agency={agency}
          label={label}
          editing={null}
          set={null}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Which effective-dated set you are looking at. History stays browsable. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`set-${agency}`} className="text-xs">
            Rate set
          </Label>
          <Select value={set.key} onValueChange={setSelectedKey}>
            <SelectTrigger id={`set-${agency}`} className="w-auto min-w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sets.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {setLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Add row
          </Button>
          <Button onClick={() => setCircularOpen(true)}>
            <CalendarPlus className="size-4" /> New circular
          </Button>
        </div>
      </div>

      {/* What this set's rows mean, and whether it is the one in force. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        {set.status === "current" && <Badge variant="secondary">In force</Badge>}
        {set.status === "scheduled" && <Badge variant="outline">Starts {formatDate(set.effective_from)}</Badge>}
        {set.status === "past" && (
          <Badge variant="outline" className="gap-1">
            <History className="size-3" /> Superseded
          </Badge>
        )}
        <span className="text-muted-foreground">
          {mixedBases
            ? "This set mixes shapes — see the Shape column on each row."
            : BASIS_EXPLAINER[bases[0]]}
        </span>
      </div>

      {set.status === "past" && (
        <p className="text-xs text-muted-foreground">
          You are viewing history. Payslips already computed cite these rows, so
          editing them rewrites the record of what was applied. To change rates
          going forward, use <span className="font-medium">New circular</span>.
        </p>
      )}

      <DataTable
        columns={columns}
        data={set.rows}
        searchPlaceholder={`Search ${label} brackets…`}
        emptyMessage="No rows in this set."
      />

      <PreviewBox agency={agency} label={label} />

      <BracketDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agency={agency}
        label={label}
        editing={null}
        set={set}
      />
      <BracketDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        agency={agency}
        label={label}
        editing={editing}
        set={set}
      />
      <NewCircularDialog
        open={circularOpen}
        onOpenChange={setCircularOpen}
        agency={agency}
        label={label}
        current={sets.find((s) => s.effective_to === null) ?? null}
        onDone={() => setSelectedKey(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this rate row?"
        description={
          "The row is kept for audit, but stops being used straight away. If a salary " +
          "then falls in no bracket, payroll will refuse to compute rather than silently " +
          "contribute nothing. To retire a whole set of rates, use New circular instead."
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await softDeleteContributionBracket(deleting.id);
          if (res.ok) toast.success("Rate row removed");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

/** The employee or employer side of one row, in the shape that row actually is. */
function ShareCell({ row, side }: { row: ContributionBracketRow; side: "ee" | "er" }) {
  const percent = side === "ee" ? row.ee_percent : row.er_percent;
  const fixedAmount = side === "ee" ? row.ee_amount_centavos : row.er_amount_centavos;
  const extra = side === "er" ? row.er_extra_centavos : 0;

  if (row.basis === "fixed") {
    return (
      <div className="min-w-24">
        <span className="font-medium tabular-nums">{formatCentavos(fixedAmount ?? 0)}</span>
        {extra > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums">
            + {formatCentavos(extra)} add-on
          </div>
        )}
      </div>
    );
  }

  // Only an MSC row carries enough on its own to show pesos — a % -of-salary row
  // needs an actual salary, so we show the rule and let the preview do the math.
  const derived =
    row.basis === "msc_bracket" && row.credited_salary_centavos !== null
      ? amountFromMsc(row.credited_salary_centavos, percent) + extra
      : null;

  return (
    <div className="min-w-24">
      <span className="font-medium tabular-nums">{formatPercent(percent)}</span>
      {derived !== null && (
        <div className="text-xs text-muted-foreground tabular-nums">
          {formatCentavos(derived)}
          {extra > 0 && ` incl. ${formatCentavos(extra)}`}
        </div>
      )}
      {derived === null && extra > 0 && (
        <div className="text-xs text-muted-foreground tabular-nums">
          + {formatCentavos(extra)} add-on
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview — ask the DB the same question payroll asks.
// ---------------------------------------------------------------------------

function PreviewBox({ agency, label }: { agency: ContributionAgency; label: string }) {
  const [salary, setSalary] = React.useState("");
  const [onDate, setOnDate] = React.useState(() => ph_today());
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ResolvedContribution | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    const centavos = parsePesosToCentavos(salary);
    if (centavos === null) {
      setResult(null);
      setError("Enter a valid ₱ amount");
      return;
    }
    setBusy(true);
    const res = await previewContribution({
      agency,
      basis_centavos: centavos,
      on_date: onDate,
    });
    setBusy(false);
    if (res.ok) {
      setResult(res.result);
      setError(null);
    } else {
      setResult(null);
      setError(res.error);
    }
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
      <div>
        <Label className="text-sm">Check a salary</Label>
        <p className="text-xs text-muted-foreground">
          Resolved by the database itself, with the same function payroll uses —
          so what you see here is what a payslip would deduct.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`prev-salary-${agency}`} className="text-xs">
            Monthly basis ₱
          </Label>
          <Input
            id={`prev-salary-${agency}`}
            inputMode="decimal"
            className="w-40"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`prev-date-${agency}`} className="text-xs">
            On date
          </Label>
          <DatePicker
            id={`prev-date-${agency}`}
            value={onDate}
            onChange={setOnDate}
            className="w-44"
          />
        </div>
        <Button variant="outline" onClick={run} disabled={busy || salary.trim() === ""}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Check
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {result && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-background p-2 text-sm">
          {result.credited_salary_centavos !== null && (
            <span>
              <span className="text-muted-foreground">MSC </span>
              <span className="font-semibold tabular-nums">
                {formatCentavos(result.credited_salary_centavos)}
              </span>
            </span>
          )}
          <span>
            <span className="text-muted-foreground">Employee </span>
            <span className="font-semibold tabular-nums">
              {formatCentavos(result.ee_amount_centavos)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Employer </span>
            <span className="font-semibold tabular-nums">
              {formatCentavos(result.er_amount_centavos)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {label} · monthly, before any semi-monthly split
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New circular — the whole point of effective dating, and what makes 61 SSS
// rows a one-dialog job.
// ---------------------------------------------------------------------------

const circularFormSchema = z
  .object({
    effective_from: z.string().trim().min(1, "Pick the date the new rates take effect"),
    source_ref: z.string().trim().min(1, "Cite the circular this comes from"),
    // blank = keep each row's own percent. No numeric default: a rate typed
    // here is the owner's, never ours.
    ee_percent: z.string().refine(isPercentInput, "Enter a valid percent"),
    er_percent: z.string().refine(isPercentInput, "Enter a valid percent"),
  })
  .refine((d) => d.effective_from !== "", { path: ["effective_from"], message: "Required" });

type CircularValues = z.infer<typeof circularFormSchema>;

function NewCircularDialog({
  open,
  onOpenChange,
  agency,
  label,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agency: ContributionAgency;
  label: string;
  current: RateSet | null;
  onDone: () => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CircularValues>({
    resolver: zodResolver(circularFormSchema),
    defaultValues: { effective_from: "", source_ref: "", ee_percent: "", er_percent: "" },
  });

  React.useEffect(() => {
    if (open) reset({ effective_from: "", source_ref: "", ee_percent: "", er_percent: "" });
  }, [open, reset]);

  const effectiveFrom = watch("effective_from");

  async function onSubmit(values: CircularValues) {
    const res = await startNewCircular({
      agency,
      effective_from: values.effective_from,
      source_ref: values.source_ref,
      ee_percent: values.ee_percent.trim() === "" ? null : Number(values.ee_percent),
      er_percent: values.er_percent.trim() === "" ? null : Number(values.er_percent),
    });
    if (res.ok) {
      toast.success(`New ${label} rates take effect ${formatDate(values.effective_from)}`);
      onDone();
      onOpenChange(false);
    } else toast.error(res.error);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New {label} circular</DialogTitle>
          <DialogDescription>
            Closes the current rates the day before the new ones start, then
            copies every row forward as a new effective-dated set. Nothing is
            deleted — the old rates stay on record as what was applied at the
            time.
          </DialogDescription>
        </DialogHeader>

        {current === null ? (
          <p className="text-sm text-muted-foreground">
            There are no current {label} rates to supersede. Add the first row
            instead.
          </p>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <p>
                Copying{" "}
                <span className="font-semibold tabular-nums">{current.rows.length}</span>{" "}
                {current.rows.length === 1 ? "row" : "rows"} in force since{" "}
                <span className="font-semibold">{formatDate(current.effective_from)}</span>.
              </p>
              {effectiveFrom !== "" && (
                <p className="mt-1 text-muted-foreground">
                  They will be closed on{" "}
                  <span className="font-medium">{formatDate(previousDay(effectiveFrom))}</span>{" "}
                  and the copies take effect{" "}
                  <span className="font-medium">{formatDate(effectiveFrom)}</span>.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="circ-from">Effective from</Label>
              <DatePicker
                id="circ-from"
                value={effectiveFrom}
                onChange={(v) => setValue("effective_from", v, { shouldValidate: true })}
              />
              {errors.effective_from && (
                <p className="text-sm text-destructive">{errors.effective_from.message}</p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="circ-source">Source reference</Label>
              <Input
                id="circ-source"
                placeholder="The circular these rates come from"
                {...register("source_ref")}
              />
              {errors.source_ref && (
                <p className="text-sm text-destructive">{errors.source_ref.message}</p>
              )}
            </div>

            <div className="grid gap-3 rounded-md border p-3">
              <div>
                <Label className="text-sm">Change the rate on every copied row</Label>
                <p className="text-xs text-muted-foreground">
                  Leave blank to carry each row&apos;s existing percent forward
                  untouched. Fill one in when a circular moves the whole rate —
                  then fine-tune individual rows afterwards.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="circ-ee" className="text-xs">
                    Employee %
                  </Label>
                  <Input
                    id="circ-ee"
                    inputMode="decimal"
                    placeholder="unchanged"
                    {...register("ee_percent")}
                  />
                  {errors.ee_percent && (
                    <p className="text-xs text-destructive">{errors.ee_percent.message}</p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="circ-er" className="text-xs">
                    Employer %
                  </Label>
                  <Input
                    id="circ-er"
                    inputMode="decimal"
                    placeholder="unchanged"
                    {...register("er_percent")}
                  />
                  {errors.er_percent && (
                    <p className="text-xs text-destructive">{errors.er_percent.message}</p>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="size-4 animate-spin" />}
                Create new rates
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The day before an ISO date, in UTC so no timezone can shift it. */
function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// One row. Which fields exist depends on the row's shape, so the form follows
// the shape rather than showing every column and hoping.
// ---------------------------------------------------------------------------

/** Money, or blank. Bounds are the DB's business, not ours. */
function isMoneyInput(v: string): boolean {
  return v.trim() === "" || parsePesosToCentavos(v) !== null;
}

/**
 * A percent, or blank. Deliberately unbounded above: the only limit the schema
 * states is `>= 0`, and inventing a ceiling here would be hardcoding a rate
 * rule. Out-of-range values come back from Postgres as a legible message.
 */
function isPercentInput(v: string): boolean {
  return v.trim() === "" || /^\d+(\.\d+)?$/.test(v.trim());
}

const bracketFormSchema = z
  .object({
    basis: z.enum(["msc_bracket", "percent_of_salary", "fixed"]),
    effective_from: z.string().trim().min(1, "Effective from is required"),
    effective_to: z.string(),
    salary_min: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    salary_max: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    credited_salary: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    ee_percent: z.string().refine(isPercentInput, "Enter a valid percent"),
    er_percent: z.string().refine(isPercentInput, "Enter a valid percent"),
    basis_floor: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    basis_ceiling: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    er_extra: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    ee_amount: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    er_amount: z.string().refine(isMoneyInput, "Enter a valid ₱ amount"),
    note: z.string(),
    source_ref: z.string(),
  })
  // the same shape rules the table's CHECK constraints enforce
  .refine((d) => d.basis !== "msc_bracket" || d.credited_salary.trim() !== "", {
    message: "An MSC-bracket row needs its credited salary (MSC)",
    path: ["credited_salary"],
  })
  .refine(
    (d) => d.basis !== "fixed" || (d.ee_amount.trim() !== "" && d.er_amount.trim() !== ""),
    { message: "A fixed row needs both amounts", path: ["ee_amount"] }
  )
  .refine((d) => d.effective_to === "" || d.effective_to >= d.effective_from, {
    message: "Effective-to must be on or after effective-from",
    path: ["effective_to"],
  })
  .refine(
    (d) => {
      if (d.salary_max.trim() === "") return true;
      const min = parsePesosToCentavos(d.salary_min.trim() === "" ? "0" : d.salary_min);
      const max = parsePesosToCentavos(d.salary_max);
      return min === null || max === null || max >= min;
    },
    { message: "The salary maximum must be at or above the minimum", path: ["salary_max"] }
  );

type BracketValues = z.infer<typeof bracketFormSchema>;

const BASIS_OPTIONS: { value: ContributionBasis; label: string }[] = [
  { value: "msc_bracket", label: BASIS_LABEL.msc_bracket },
  { value: "percent_of_salary", label: BASIS_LABEL.percent_of_salary },
  { value: "fixed", label: BASIS_LABEL.fixed },
];

function BracketDialog({
  open,
  onOpenChange,
  agency,
  label,
  editing,
  set,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agency: ContributionAgency;
  label: string;
  editing: ContributionBracketRow | null;
  set: RateSet | null;
}) {
  const today = React.useMemo(() => ph_today(), []);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<BracketValues>({
    resolver: zodResolver(bracketFormSchema),
    // Shape only — every rate field starts empty. The one structural default is
    // the shape of the set you are adding to, read off that set's own rows.
    defaultValues: {
      basis: set?.rows[0]?.basis ?? "percent_of_salary",
      effective_from: "",
      effective_to: "",
      salary_min: "",
      salary_max: "",
      credited_salary: "",
      ee_percent: "",
      er_percent: "",
      basis_floor: "",
      basis_ceiling: "",
      er_extra: "",
      ee_amount: "",
      er_amount: "",
      note: "",
      source_ref: "",
    },
  });

  const toPesos = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

  React.useEffect(() => {
    if (!open) return;
    reset(
      editing
        ? {
            basis: editing.basis,
            effective_from: editing.effective_from,
            effective_to: editing.effective_to ?? "",
            salary_min: toPesos(editing.salary_min_centavos),
            salary_max: toPesos(editing.salary_max_centavos),
            credited_salary: toPesos(editing.credited_salary_centavos),
            ee_percent: String(Number(editing.ee_percent)),
            er_percent: String(Number(editing.er_percent)),
            basis_floor: toPesos(editing.basis_floor_centavos),
            basis_ceiling: toPesos(editing.basis_ceiling_centavos),
            er_extra: toPesos(editing.er_extra_centavos),
            ee_amount: toPesos(editing.ee_amount_centavos),
            er_amount: toPesos(editing.er_amount_centavos),
            note: editing.note ?? "",
            source_ref: editing.source_ref ?? "",
          }
        : {
            // A new row joins the set you are looking at: its dates and its
            // citation are that set's, not values we invented.
            basis: set?.rows[0]?.basis ?? "percent_of_salary",
            effective_from: set?.effective_from ?? "",
            effective_to: set?.effective_to ?? "",
            salary_min: "",
            salary_max: "",
            credited_salary: "",
            ee_percent: "",
            er_percent: "",
            basis_floor: "",
            basis_ceiling: "",
            er_extra: "",
            ee_amount: "",
            er_amount: "",
            note: "",
            source_ref: set?.source_ref ?? "",
          }
    );
  }, [open, editing, set, reset]);

  const basis = watch("basis");
  const effectiveFrom = watch("effective_from");
  const effectiveTo = watch("effective_to");

  const isHistory =
    editing !== null && editing.effective_to !== null && editing.effective_to < today;
  const isLive =
    editing !== null &&
    editing.effective_from <= today &&
    (editing.effective_to === null || editing.effective_to >= today);

  async function onSubmit(values: BracketValues) {
    const money = (v: string) => (v.trim() === "" ? null : parsePesosToCentavos(v));
    const res = await upsertContributionBracket({
      id: editing?.id,
      agency,
      effective_from: values.effective_from,
      effective_to: values.effective_to.trim() === "" ? null : values.effective_to,
      salary_min_centavos: money(values.salary_min) ?? 0,
      salary_max_centavos: money(values.salary_max),
      basis: values.basis,
      // the schema allows an MSC only on an MSC row — don't smuggle a stale one
      credited_salary_centavos:
        values.basis === "msc_bracket" ? money(values.credited_salary) : null,
      ee_percent: values.basis === "fixed" ? 0 : Number(values.ee_percent || "0"),
      er_percent: values.basis === "fixed" ? 0 : Number(values.er_percent || "0"),
      basis_floor_centavos: values.basis === "percent_of_salary" ? money(values.basis_floor) : null,
      basis_ceiling_centavos:
        values.basis === "percent_of_salary" ? money(values.basis_ceiling) : null,
      er_extra_centavos: money(values.er_extra) ?? 0,
      ee_amount_centavos: values.basis === "fixed" ? money(values.ee_amount) : null,
      er_amount_centavos: values.basis === "fixed" ? money(values.er_amount) : null,
      note: values.note.trim() === "" ? null : values.note,
      source_ref: values.source_ref.trim() === "" ? null : values.source_ref,
    });
    if (res.ok) {
      toast.success(editing ? "Rate row updated" : "Rate row added");
      onOpenChange(false);
    } else toast.error(res.error);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${label} rate row` : `Add ${label} rate row`}
          </DialogTitle>
          <DialogDescription>{BASIS_EXPLAINER[basis]}</DialogDescription>
        </DialogHeader>

        {isHistory && (
          <Alert variant="destructive">
            <History />
            <AlertTitle>This row is history</AlertTitle>
            <AlertDescription>
              It stopped applying on {formatDate(editing.effective_to as string)}, and payslips
              computed then cite it. Editing it rewrites the record of what was
              applied. If rates have changed, close this dialog and use New
              circular instead.
            </AlertDescription>
          </Alert>
        )}
        {isLive && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>This row is in force</AlertTitle>
            <AlertDescription>
              Edits apply to future payroll runs. Use this to fix a typo — if
              an agency has issued new rates, use New circular so the old ones
              stay on record.
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="br-basis">Shape</Label>
            <Select
              value={basis}
              onValueChange={(v) => setValue("basis", v as ContributionBasis, { shouldValidate: true })}
            >
              <SelectTrigger id="br-basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASIS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Effective dating */}
          <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
            <div>
              <Label className="text-sm">Effective dates</Label>
              <p className="text-xs text-muted-foreground">
                Leave “to” blank while these rates are current. Setting it is how
                a rate is retired — the row stays as the record of what applied.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="br-from" className="text-xs">
                  From
                </Label>
                <DatePicker
                  id="br-from"
                  value={effectiveFrom}
                  onChange={(v) => setValue("effective_from", v, { shouldValidate: true })}
                  className="w-full"
                />
                {errors.effective_from && (
                  <p className="text-xs text-destructive">{errors.effective_from.message}</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="br-to" className="text-xs">
                  To
                </Label>
                <DatePicker
                  id="br-to"
                  value={effectiveTo}
                  onChange={(v) => setValue("effective_to", v, { shouldValidate: true })}
                  placeholder="blank = current"
                  className="w-full"
                />
                {errors.effective_to && (
                  <p className="text-xs text-destructive">{errors.effective_to.message}</p>
                )}
              </div>
            </div>
          </div>

          {/* Which salaries this row matches */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="br-min" className="text-xs">
                Monthly salary from ₱
              </Label>
              <Input
                id="br-min"
                inputMode="decimal"
                placeholder="blank = from zero"
                {...register("salary_min")}
              />
              {errors.salary_min && (
                <p className="text-xs text-destructive">{errors.salary_min.message}</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="br-max" className="text-xs">
                Monthly salary to ₱
              </Label>
              <Input
                id="br-max"
                inputMode="decimal"
                placeholder="blank = open-ended"
                {...register("salary_max")}
              />
              {errors.salary_max && (
                <p className="text-xs text-destructive">{errors.salary_max.message}</p>
              )}
            </div>
          </div>

          {basis === "msc_bracket" && (
            <div className="grid gap-1.5">
              <Label htmlFor="br-msc" className="text-xs">
                Credited salary / MSC ₱
              </Label>
              <Input id="br-msc" inputMode="decimal" {...register("credited_salary")} />
              <p className="text-xs text-muted-foreground">
                The percents below apply to this, not to the employee&apos;s
                actual salary. The salary range above only chooses the bracket.
              </p>
              {errors.credited_salary && (
                <p className="text-xs text-destructive">{errors.credited_salary.message}</p>
              )}
            </div>
          )}

          {basis === "fixed" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="br-ee-amt" className="text-xs">
                  Employee amount ₱
                </Label>
                <Input id="br-ee-amt" inputMode="decimal" {...register("ee_amount")} />
                {errors.ee_amount && (
                  <p className="text-xs text-destructive">{errors.ee_amount.message}</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="br-er-amt" className="text-xs">
                  Employer amount ₱
                </Label>
                <Input id="br-er-amt" inputMode="decimal" {...register("er_amount")} />
                {errors.er_amount && (
                  <p className="text-xs text-destructive">{errors.er_amount.message}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="br-ee" className="text-xs">
                  Employee %
                </Label>
                <Input id="br-ee" inputMode="decimal" {...register("ee_percent")} />
                {errors.ee_percent && (
                  <p className="text-xs text-destructive">{errors.ee_percent.message}</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="br-er" className="text-xs">
                  Employer %
                </Label>
                <Input id="br-er" inputMode="decimal" {...register("er_percent")} />
                {errors.er_percent && (
                  <p className="text-xs text-destructive">{errors.er_percent.message}</p>
                )}
              </div>
            </div>
          )}

          {basis === "percent_of_salary" && (
            <div className="grid gap-3 rounded-md border p-3">
              <div>
                <Label className="text-sm">Basis clamp</Label>
                <p className="text-xs text-muted-foreground">
                  The salary is pulled up to the floor and down to the ceiling
                  before the percents apply. Blank means no clamp on that side.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="br-floor" className="text-xs">
                    Floor ₱
                  </Label>
                  <Input
                    id="br-floor"
                    inputMode="decimal"
                    placeholder="blank = none"
                    {...register("basis_floor")}
                  />
                  {errors.basis_floor && (
                    <p className="text-xs text-destructive">{errors.basis_floor.message}</p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="br-ceiling" className="text-xs">
                    Ceiling ₱
                  </Label>
                  <Input
                    id="br-ceiling"
                    inputMode="decimal"
                    placeholder="blank = none"
                    {...register("basis_ceiling")}
                  />
                  {errors.basis_ceiling && (
                    <p className="text-xs text-destructive">{errors.basis_ceiling.message}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="br-extra" className="text-xs">
              Employer add-on ₱
            </Label>
            <Input
              id="br-extra"
              inputMode="decimal"
              placeholder="blank = none"
              {...register("er_extra")}
            />
            <p className="text-xs text-muted-foreground">
              A flat employer-only amount on top of the percent, such as
              SSS&apos;s EC. Never deducted from the employee.
            </p>
            {errors.er_extra && (
              <p className="text-xs text-destructive">{errors.er_extra.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="br-note" className="text-xs">
                Note
              </Label>
              <Input id="br-note" {...register("note")} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="br-source" className="text-xs">
                Source reference
              </Label>
              <Input
                id="br-source"
                placeholder="The circular this row comes from"
                {...register("source_ref")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
