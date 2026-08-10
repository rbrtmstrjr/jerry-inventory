import { requireOwner } from "@/lib/auth";
import { AppShell } from "@/components/shell/app-shell";

export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only the auth check blocks the shell — blocking on the badge counts would
  // slow every owner page. The badges fetch their own counts client-side.
  const profile = await requireOwner();

  return (
    <AppShell
      variant="owner"
      role={profile.role}
      userName={profile.full_name}
      contextLabel={profile.role === "admin" ? "Admin" : "Owner"}
    >
      {children}
    </AppShell>
  );
}
