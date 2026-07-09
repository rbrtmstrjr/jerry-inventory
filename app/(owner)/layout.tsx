import { requireOwner } from "@/lib/auth";
import { AppShell } from "@/components/shell/app-shell";

export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireOwner();

  return (
    <AppShell variant="owner" userName={profile.full_name} contextLabel="Owner">
      {children}
    </AppShell>
  );
}
