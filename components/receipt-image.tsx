"use client";

import * as React from "react";
import { ReceiptText } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Spinner } from "@/components/ui/spinner";

export const RECEIPTS_BUCKET = "receipts";

/**
 * Receipt image from the PRIVATE receipts bucket — resolved via a signed URL
 * (only the owner's session can mint one; Storage RLS enforces it).
 */
export function ReceiptImage({
  path,
  alt = "Receipt",
  className,
}: {
  path: string;
  alt?: string;
  className?: string;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .createSignedUrl(path, 3600);
      if (!cancelled) {
        if (error || !data) setFailed(true);
        else setUrl(data.signedUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border bg-muted text-muted-foreground",
          className
        )}
      >
        <ReceiptText className="size-6" />
      </div>
    );
  }
  if (!url) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border bg-muted",
          className
        )}
      >
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }
  // signed URL — next/image optimization would leak/expire it; plain img is right here
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={cn("rounded-md border object-contain", className)} />;
}
