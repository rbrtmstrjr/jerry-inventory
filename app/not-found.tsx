import Link from "next/link";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60svh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
          <Compass className="size-6 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          That page doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
        <div className="mt-5 flex justify-center">
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
