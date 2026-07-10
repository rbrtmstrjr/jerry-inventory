"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/product-image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ImageUploadField,
  type ImageAction,
} from "@/components/image-upload-field";
import { setShopProductImage } from "./actions";

export interface PhotoTarget {
  kind: "part" | "engine";
  id: string;
  name: string;
  image_path: string | null;
}

/**
 * Employee photo editor — only reachable for items in their own shop;
 * the storage policies + DB function enforce that server-side too.
 */
export function ShopPhotoDialog({
  target,
  onClose,
}: {
  target: PhotoTarget | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [action, setAction] = React.useState<ImageAction>({ type: "keep" });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (target) setAction({ type: "keep" });
  }, [target]);

  async function onSave() {
    if (!target || action.type === "keep") {
      onClose();
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const objectPath = `${target.id}.webp`;

    if (action.type === "set") {
      const { error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(objectPath, action.image.blob, {
          upsert: true,
          contentType: "image/webp",
          cacheControl: "3600",
        });
      if (error) {
        setBusy(false);
        toast.error(`Upload failed: ${error.message}`);
        return;
      }
      const res = await setShopProductImage({
        kind: target.kind,
        id: target.id,
        clear: false,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Photo saved for ${target.name}`);
    } else {
      await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([objectPath]);
      const res = await setShopProductImage({
        kind: target.kind,
        id: target.id,
        clear: true,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Photo removed");
    }
    router.refresh();
    onClose();
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Product photo</DialogTitle>
          <DialogDescription>
            {target?.name} — a clear photo helps everyone find items faster.
          </DialogDescription>
        </DialogHeader>
        <ImageUploadField
          currentPath={target?.image_path ?? null}
          action={action}
          onActionChange={setAction}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy || action.type === "keep"}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save photo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
