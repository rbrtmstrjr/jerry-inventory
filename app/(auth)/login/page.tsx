import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Anchor } from "lucide-react";

import { getProfile } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Already signed in? Go straight to the right home.
  const profile = await getProfile().catch(() => null);
  if (profile) redirect(profile.role === "owner" ? "/dashboard" : "/shop");

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Anchor className="size-5" />
        </div>
        <div className="leading-tight">
          <div className="font-semibold">Maccky&apos;s Marine</div>
          <div className="text-xs text-muted-foreground">
            Inventory &amp; Approvals
          </div>
        </div>
      </div>
      <LoginForm />
    </div>
  );
}
