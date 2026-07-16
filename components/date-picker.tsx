"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * shadcn date picker over a YYYY-MM-DD string value (what the app's queries
 * and DB columns speak).
 */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder = "Pick a date",
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  /** YYYY-MM-DD or "" */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** For filter bars with no visible sibling <Label> pointing at this field. */
  "aria-label"?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = value ? new Date(value + "T00:00:00") : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={ariaLabel}
          className={cn(
            "w-38 justify-start font-normal",
            !value && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="size-4" />
          {selected ? format(selected, "MMM d, yyyy") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (date) onChange(format(date, "yyyy-MM-dd"));
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
