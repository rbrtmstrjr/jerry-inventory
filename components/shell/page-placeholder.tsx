import { Construction } from "lucide-react";

/** Temporary empty-state for screens delivered in a later build step. */
export function PagePlaceholder({
  title,
  description,
  step,
}: {
  title: string;
  description: string;
  step: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12 text-center">
        <Construction className="size-8 text-muted-foreground" />
        <div className="text-sm font-medium">Under construction</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          This screen arrives in build step {step}.
        </p>
      </div>
    </div>
  );
}
