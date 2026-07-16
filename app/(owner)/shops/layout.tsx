// Per-shop profitability moved to /reports?tab=shops — it's financial
// reporting, not shop management. This page is now purely operational, so the
// tab bar went with it (one tab is not a tab bar).
export default function ShopsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Shops &amp; Employees
        </h1>
        <p className="text-sm text-muted-foreground">
          Branches, their login accounts, map pins, and closing a shop. How each
          one performs lives in Reports.
        </p>
      </div>
      {children}
    </div>
  );
}
