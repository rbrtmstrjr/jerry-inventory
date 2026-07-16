"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * No current-password gate here, unlike Settings → Account — and that is the
 * point of recovery. Proof of identity is the emailed link plus the session it
 * established; demanding the password you came here because you forgot would
 * make the safety net useless.
 *
 * Same strength rules as Account, deliberately: the way in must not be a way to
 * set a weaker password than the front door allows.
 */
export function ResetForm() {
  const router = useRouter();
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      toast.error("Password must contain both a letter and a number");
      return;
    }
    if (next !== confirm) {
      toast.error("The two passwords don't match");
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: next });
    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }

    toast.success("Password updated — you're signed in");
    // "/" is the role-aware redirect, so this lands the owner on /dashboard and
    // a shop on /shop without this page needing to know which it is.
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="rst-pw">New password</Label>
        <Input
          id="rst-pw"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="rst-pw2">Confirm new password</Label>
        <Input
          id="rst-pw2"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        At least 8 characters, with a letter and a number.
      </p>
      <Button type="submit" disabled={busy || !next || !confirm}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
        Save and sign in
      </Button>
    </form>
  );
}
