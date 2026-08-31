/** The DB stores only the object path within the `product-images` bucket
 *  (e.g. "3f2a….webp") — never bytes, never full URLs. */

export const PRODUCT_IMAGE_BUCKET = "product-images";

/** Public CDN URL for a stored product image path (null-safe). */
export function productImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${path}`;
}

export interface ProcessedImage {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  processedBytes: number;
}

const MAX_EDGE = 800;
const WEBP_QUALITY = 0.8;
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10MB pre-compression cap

/** Validate → decode → resize (longest edge ≤ 800px, never upscale) → WebP.
 *  Throws a user-readable Error on wrong type, too big, or undecodable. */
export async function processProductImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file is not an image — pick a JPG, PNG, or WebP.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("Image is larger than 10MB — pick a smaller photo.");
  }

  let bitmap: ImageBitmap;
  try {
    // respects EXIF orientation from phone photos
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "Couldn't read that image — the file may be damaged, or a HEIC photo (not supported here). Try exporting it as JPG or PNG."
    );
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser blocked image processing.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", WEBP_QUALITY)
  );
  if (!blob) throw new Error("Your browser couldn't convert the image to WebP.");

  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    width,
    height,
    originalBytes: file.size,
    processedBytes: blob.size,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`; // not-a-qty-decimal: megabytes
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
