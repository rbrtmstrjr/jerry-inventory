"use client";

import * as React from "react";
import Image from "next/image";
import { ArrowRight, ImagePlus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  formatBytes,
  processProductImage,
  productImageUrl,
  type ProcessedImage,
} from "@/lib/product-image";
import { Button } from "@/components/ui/button";

/** What the form should do with the image on save. */
export type ImageAction =
  | { type: "keep" }
  | { type: "set"; image: ProcessedImage }
  | { type: "remove" };

/**
 * Owner-only image field: pick or drag a photo → it's resized to ≤800px and
 * converted to WebP in the browser → preview with before/after sizes.
 * Nothing uploads until the form is saved.
 */
export function ImageUploadField({
  currentPath,
  action,
  onActionChange,
}: {
  currentPath: string | null;
  action: ImageAction;
  onActionChange: (a: ImageAction) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [processing, setProcessing] = React.useState(false);

  // revoke stale object URLs
  const prevUrl = React.useRef<string | null>(null);
  React.useEffect(() => {
    const url = action.type === "set" ? action.image.previewUrl : null;
    if (prevUrl.current && prevUrl.current !== url) {
      URL.revokeObjectURL(prevUrl.current);
    }
    prevUrl.current = url;
  }, [action]);

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    setProcessing(true);
    try {
      const image = await processProductImage(file);
      onActionChange({ type: "set", image });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't process that image.");
    } finally {
      setProcessing(false);
    }
  }

  const showingNew = action.type === "set";
  const showingCurrent =
    action.type === "keep" && !!currentPath && !!productImageUrl(currentPath);
  const hasAnything = showingNew || showingCurrent;

  return (
    <div className="flex items-start gap-3">
      {/* Preview / drop zone */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        aria-label={hasAnything ? "Replace product photo" : "Add product photo"}
        className={cn(
          "relative flex size-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border-2 border-dashed bg-muted/40 text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          dragging && "border-primary bg-accent",
          hasAnything && "border-solid"
        )}
      >
        {showingNew ? (
          // preview blob — plain img is correct here (local object URL)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={action.image.previewUrl}
            alt="New product photo preview"
            className="size-full object-cover"
          />
        ) : showingCurrent ? (
          <Image
            src={productImageUrl(currentPath)!}
            alt="Current product photo"
            width={96}
            height={96}
            className="size-full object-cover"
          />
        ) : (
          <ImagePlus className="size-7" />
        )}
      </button>

      <div className="flex min-w-0 flex-col gap-2 text-sm">
        {showingNew ? (
          <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
            <span className="line-through">{formatBytes(action.image.originalBytes)}</span>
            <ArrowRight className="size-3.5" />
            <span className="font-medium text-foreground">
              {formatBytes(action.image.processedBytes)} WebP
            </span>
            <span>
              · {action.image.width}×{action.image.height}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            {showingCurrent
              ? "Photo helps employees recognize this item."
              : "Optional — JPG/PNG up to 10MB. Compressed to ~40KB in your browser."}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={processing}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4" />
            {processing ? "Processing…" : hasAnything ? "Replace" : "Choose photo"}
          </Button>
          {(hasAnything || action.type === "remove") &&
            (action.type === "remove" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onActionChange({ type: "keep" })}
              >
                Undo remove
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() =>
                  onActionChange(
                    showingNew && !currentPath ? { type: "keep" } : { type: "remove" }
                  )
                }
              >
                <Trash2 className="size-4" /> Remove
              </Button>
            ))}
        </div>
        {action.type === "remove" && (
          <p className="text-xs text-destructive">Photo will be removed on save.</p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
