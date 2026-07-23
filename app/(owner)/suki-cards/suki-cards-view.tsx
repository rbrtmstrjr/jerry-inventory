"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  BadgePercent,
  Check,
  ChevronsUpDown,
  MoreHorizontal,
  Plus,
  Printer,
  RefreshCcw,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { createDiscountCard, reissueDiscountCard, setDiscountCardStatus } from "./actions";

export interface CardRow {
  id: string;
  card_no: string;
  status: "active" | "inactive";
  issued_at: string;
  note: string | null;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  uses: number;
  saved_centavos: number;
}

interface CustomerOption {
  id: string;
  name: string;
  phone: string | null;
}

export function SukiCardsView({
  cards,
  customers,
  enginePct,
  partPct,
}: {
  cards: CardRow[];
  customers: CustomerOption[];
  enginePct: number;
  partPct: number;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deactivating, setDeactivating] = React.useState<CardRow | null>(null);
  const [reissuing, setReissuing] = React.useState<CardRow | null>(null);

  const columns: ColumnDef<CardRow>[] = [
    {
      accessorKey: "customer_name",
      header: ({ column }) => <SortableHeader column={column}>Customer</SortableHeader>,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.original.customer_name}</div>
          {row.original.customer_phone && (
            <div className="text-xs text-muted-foreground">{row.original.customer_phone}</div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "card_no",
      header: "Card no.",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.card_no}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "active" ? (
          <Badge>Active</Badge>
        ) : (
          <Badge variant="outline">Inactive</Badge>
        ),
    },
    {
      accessorKey: "issued_at",
      header: ({ column }) => <SortableHeader column={column}>Issued</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {format(new Date(row.original.issued_at), "MMM d, yyyy")}
        </span>
      ),
    },
    {
      accessorKey: "uses",
      header: ({ column }) => <SortableHeader column={column}>Uses</SortableHeader>,
      cell: ({ row }) => <span className="tabular-nums">{row.original.uses}</span>,
    },
    {
      accessorKey: "saved_centavos",
      header: ({ column }) => <SortableHeader column={column}>Saved (suki)</SortableHeader>,
      cell: ({ row }) => (
        <span className="tabular-nums">{formatCentavos(row.original.saved_centavos)}</span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button asChild variant="outline" size="sm">
              <Link href={`/suki-cards/${c.id}/print`}>
                <Printer className="size-3.5" /> Print
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Card actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {c.status === "active" ? (
                  <DropdownMenuItem onClick={() => setDeactivating(c)}>
                    Deactivate (lost card)
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={async () => {
                      const res = await setDiscountCardStatus(c.id, "active");
                      if (res.ok) toast.success(`${c.card_no} reactivated`);
                      else toast.error(res.error);
                    }}
                  >
                    Reactivate
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setReissuing(c)}>
                  <RefreshCcw className="size-4" /> Reissue (new number)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BadgePercent className="size-4" /> Issued cards
          </CardTitle>
          <CardDescription>
            A scan at Record Sale applies{" "}
            <span className="font-medium text-foreground">
              {enginePct}% off engines · {partPct}% off parts
            </span>{" "}
            (change the rates in Settings → Alerts). One active card per
            customer — a lost card is deactivated and reissued with a new number,
            and the old one stops scanning immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={cards}
            searchPlaceholder="Search customer or card no…"
            emptyMessage="No cards yet — create one for your first suki."
            toolbar={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> New card
              </Button>
            }
          />
        </CardContent>
      </Card>

      {createOpen && (
        <CreateCardDialog customers={customers} onClose={() => setCreateOpen(false)} />
      )}

      {deactivating && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setDeactivating(null)}
          title={`Deactivate ${deactivating.card_no}?`}
          description={`${deactivating.customer_name}'s card will stop working at every shop immediately. Reissue a new one if they lost it.`}
          confirmLabel="Deactivate"
          destructive
          onConfirm={async () => {
            const res = await setDiscountCardStatus(deactivating.id, "inactive");
            if (res.ok) toast.success(`${deactivating.card_no} deactivated`);
            else toast.error(res.error);
            setDeactivating(null);
          }}
        />
      )}

      {reissuing && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setReissuing(null)}
          title={`Reissue a card for ${reissuing.customer_name}?`}
          description={`${reissuing.card_no} will be deactivated and a NEW number minted — print and hand over the new card.`}
          confirmLabel="Reissue"
          onConfirm={async () => {
            const res = await reissueDiscountCard(reissuing.id);
            if (res.ok) toast.success(`New card ${res.card_no} created — print it now`);
            else toast.error(res.error);
            setReissuing(null);
          }}
        />
      )}
    </div>
  );
}

/** Mounted per open so it starts fresh (same pattern as the login dialog). */
function CreateCardDialog({
  customers,
  onClose,
}: {
  customers: CustomerOption[];
  onClose: () => void;
}) {
  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newPhone, setNewPhone] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const selected = customers.find((c) => c.id === customerId);

  async function onSave() {
    if (mode === "existing" && !customerId) {
      toast.error("Pick a customer");
      return;
    }
    if (mode === "new" && newName.trim() === "") {
      toast.error("Enter the customer's name");
      return;
    }
    setBusy(true);
    const res = await createDiscountCard({
      customer_id: mode === "existing" ? customerId : null,
      new_customer:
        mode === "new"
          ? { name: newName.trim(), phone: newPhone.trim() || undefined }
          : null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Card ${res.card_no} created — print it for the suki`);
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New suki card</DialogTitle>
          <DialogDescription>
            The card belongs to one customer — scanning it identifies them and
            applies their discount.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={mode === "existing" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("existing")}
            >
              Existing customer
            </Button>
            <Button
              type="button"
              variant={mode === "new" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("new")}
            >
              New customer
            </Button>
          </div>

          {mode === "existing" ? (
            <div className="grid gap-1.5">
              <Label className="text-xs">Customer</Label>
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={pickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="truncate">
                      {selected ? selected.name : "Pick a customer…"}
                    </span>
                    <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-96 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search customers…" />
                    <CommandList>
                      <CommandEmpty>No customer found — use “New customer”.</CommandEmpty>
                      <CommandGroup>
                        {customers.map((c) => (
                          <CommandItem
                            key={c.id}
                            // the id suffix keeps the value UNIQUE — cmdk keys
                            // hover/selection by value, so two customers with
                            // the same name would otherwise highlight together
                            value={`${c.name} ${c.phone ?? ""} ${c.id}`}
                            onSelect={() => {
                              setCustomerId(c.id);
                              setPickerOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "size-4",
                                c.id === customerId ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <span className="flex-1 truncate">{c.name}</span>
                            {c.phone && (
                              <span className="text-xs text-muted-foreground">{c.phone}</span>
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <div className="grid gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="suki-new-name" className="text-xs">Name</Label>
                <Input
                  id="suki-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Customer name"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="suki-new-phone" className="text-xs">Phone (optional)</Label>
                <Input
                  id="suki-new-phone"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="09xx…"
                />
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="suki-note" className="text-xs">Note (optional)</Label>
            <Input
              id="suki-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. barangay captain, fleet owner…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>Create card</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
