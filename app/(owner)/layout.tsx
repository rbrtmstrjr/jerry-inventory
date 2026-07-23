import { requireOwner } from "@/lib/auth";
import { AppShell } from "@/components/shell/app-shell";

export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only the auth check blocks the shell — NOT the sidebar counts. Blocking the
  // shared layout on the badge counts (which include the expensive receivables /
  // low-stock views) would slow EVERY owner page, the opposite of the goal. The
  // badges fetch their own counts client-side (batched via one RPC, below) so
  // the shell paints instantly and the counts stream in together a moment later.
  const profile = await requireOwner();

  return (
    <AppShell variant="owner" userName={profile.full_name} contextLabel="Owner">
      {children}
    </AppShell>
  );
}
