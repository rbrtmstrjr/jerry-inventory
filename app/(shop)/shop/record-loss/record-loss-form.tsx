"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronsUpDown, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { recordLoss } from "../actions";

const REASONS = [
  { value: "nasira", label: "Nasira (damaged)" },
  { value: "nawala", label: "Nawala (missing)" },
  { value: "expired", label: "Expired" },
  { value: "sample", label: "Sample / libre" },
  { value: "correction", label: "Correction" },
] as const;

export function RecordLossForm({
  stock,
  engines,
}: {
  stock: ShopStockRow[];
  engines: ShopEngineRow[];
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState("part");

  // part loss state
  const [partId, setPartId] = React.useState("");
  const [partOpen, setPartOpen] = React.useState(false);
  const [qty, setQty] = React.useState("1");

  // engine loss state
  const [engineId, setEngineId] = React.useState("");

  const [reason, setReason] = React.useState<string>("nasira");
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const part = stock.find((p) => p.part_id === partId);

  async function onSubmit() {
    const isPart = tab === "part";
    if (isPart && !partId) {
      toast.error("Pick an item");
      return;
    }
    if (!isPart && !engineId) {
      toast.error("Pick an engine");
      return;
    }
    const q = isPart ? parseInt(qty || "0", 10) : 1;
    if (isNaN(q) || q <= 0) {
      toast.error("Quantity must be positive");
      return;
    }
    if (isPart && part && q > part.qty) {
      toast.error(`Only ${part.qty} ${part.unit} on hand`);
      return;
    }
    if ((reason === "nasira" || reason === "nawala") && note.trim() === "") {
      toast.error("Add a short note — the owner will ask anyway");
      return;
    }

    setSubmitting(true);
    const res = await recordLoss({
      part_id: isPart ? partId : null,
      engine_id: isPart ? null : engineId,
      qty: q,
      reason,
      note: note.trim() || null,
    });
    setSubmitting(false);

    if (res.ok) {
      toast.success("Loss saved — submit your batch to Maccky from Submissions");
      setPartId("");
      setEngineId("");
      setQty("1");
      setNote("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Record Loss / Adjustment
        </h1>
        <p className="text-sm text-muted-foreground">
          Reason-tagged write-off request. It joins your batch and stock only
          deducts when the owner approves.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4" /> What was lost?
          </CardTitle>
          <CardDescription>
            One item per report so the owner can question each line.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="part">Part / goods</TabsTrigger>
              <TabsTrigger value="engine">Engine</TabsTrigger>
            </TabsList>
            <TabsContent value="part" className="flex flex-col gap-4 pt-3">
              <div className="grid gap-2">
                <Label>Item</Label>
                <Popover open={partOpen} onOpenChange={setPartOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="justify-between font-normal"
                    >
                      <span className="truncate">
                        {part ? part.name : "Pick from your stock…"}
                      </span>
                      <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-96 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search…" />
                      <CommandList>
                        <CommandEmpty>Nothing in stock.</CommandEmpty>
                        <CommandGroup>
                          {stock.map((p) => (
                            <CommandItem
                              key={p.part_id}
                              value={`${p.name} ${p.barcode ?? ""}`}
                              onSelect={() => {
                                setPartId(p.part_id);
                                setPartOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "size-4",
                                  p.part_id === partId ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <span className="flex-1">{p.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {p.qty} {p.unit}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="loss-qty">Quantity</Label>
                <Input
                  id="loss-qty"
                  inputMode="numeric"
                  className="w-32"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
                {part && (
                  <p className="text-xs text-muted-foreground">
                    {part.qty} {part.unit} on hand
                  </p>
                )}
              </div>
            </TabsContent>
            <TabsContent value="engine" className="flex flex-col gap-4 pt-3">
              <div className="grid min-w-0 gap-2">
                <Label>Engine</Label>
                <Select value={engineId} onValueChange={setEngineId}>
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue placeholder="Pick an engine at your shop" />
                  </SelectTrigger>
                  <SelectContent>
                    {engines.map((e) => (
                      <SelectItem key={e.engine_id} value={e.engine_id}>
                        {e.brand} {e.model} — SN {e.serial_number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TabsContent>
          </Tabs>

          <div className="grid gap-2">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="loss-note">Note</Label>
            <Textarea
              id="loss-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What happened? e.g. nabasag habang inaayos ang display"
            />
          </div>

          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Save loss report
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
