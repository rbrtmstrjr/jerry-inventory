"use client";

import * as React from "react";
import { KeyRound, Loader2, Mail, MailCheck, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Account — the security-critical section.
 *
 * THE RE-AUTH GATE. Every change here demands the CURRENT password first,
 * verified against Supabase, before the change is attempted. A live session is
 * explicitly not enough: the threat is a walked-away laptop or a lifted
 * session, and in both of those the attacker already has the session. Only the
 * password proves the person at the keyboard is Jerry.
 *
 * Verify and change happen in ONE submit, deliberately. A two-step wizard would
 * park a `verified: true` flag in client state, and a flag in client state is
 * not a gate — it is a thing to flip in a console. Here the update call is
 * physically unreachable except on the line after a successful verify.
 *
 * HONEST LIMIT: this gate is client-side, because `updateUser` runs on the
 * user's own session and there is no server action that can hold the old
 * password without being handed it. It stops a walked-away session cold, but it
 * is not a server-enforced control — someone with the session and a devtools
 * console could call updateUser directly. The server-side version of this is
 * Supabase's own "Secure password change" / "Secure email change" options
 * (Dashboard → Authentication → Providers → Email), which make the platform
 * itself demand recent re-auth. Turn those on; this gate is the UI half.
 */
export function AccountSection({
  email,
  lastSignInAt,
}: {
  email: string | null;
  lastSignInAt: string | null;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" /> Signed in as
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1">
          <p className="text-sm font-medium">{email ?? "—"}</p>
          <p className="text-xs text-muted-foreground">
            Last signed in:{" "}
            {lastSignInAt
              ? new Date(lastSignInAt).toLocaleString("en-PH", {
                  timeZone: "Asia/Manila",
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "—"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            This is your sign-in email. The business email printed on documents
            is separate — it lives under Business.
          </p>
        </CardContent>
      </Card>

      <ChangePasswordCard email={email} />
      <ChangeEmailCard email={email} />
      <ResetCard email={email} />
    </div>
  );
}

/**
 * Verify the CURRENT password by signing in with it.
 *
 * A successful call issues a fresh session for the same user, which is
 * harmless. A failed one leaves the existing session untouched — it does not
 * sign anyone out — so a wrong guess costs nothing but the error.
 */
async function verifyCurrentPassword(email: string, password: string): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return "That's not your current password.";
  return null;
}

function ChangePasswordCard({ email }: { email: string | null }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    if (next.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      toast.error("New password must contain both a letter and a number");
      return;
    }
    if (next !== confirm) {
      toast.error("The two new passwords don't match");
      return;
    }
    if (next === current) {
      toast.error("The new password is the same as your current one");
      return;
    }

    setBusy(true);
    const gate = await verifyCurrentPassword(email, current);
    if (gate) {
      setBusy(false);
      toast.error(gate);
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: next });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    toast.success("Password changed. Use it next time you sign in.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" /> Change password
        </CardTitle>
        <CardDescription>
          Your current password is required — being signed in isn&apos;t enough.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="acc-cur-pw">Current password</Label>
            <Input
              id="acc-cur-pw"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="acc-new-pw">New password</Label>
              <Input
                id="acc-new-pw"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="acc-new-pw2">Confirm new password</Label>
              <Input
                id="acc-new-pw2"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            At least 8 characters, with a letter and a number.
          </p>
          <div>
            <Button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeEmailCard({ email }: { email: string | null }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    if (!/^\S+@\S+\.\S+$/.test(next)) {
      toast.error("Enter a valid email address");
      return;
    }
    if (next !== confirm) {
      toast.error("The two email addresses don't match");
      return;
    }
    if (next.toLowerCase() === email.toLowerCase()) {
      toast.error("That's already your email address");
      return;
    }

    setBusy(true);
    const gate = await verifyCurrentPassword(email, current);
    if (gate) {
      setBusy(false);
      toast.error(gate);
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ email: next });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSentTo(next);
    setCurrent("");
    setNext("");
    setConfirm("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4" /> Change sign-in email
        </CardTitle>
        <CardDescription>
          Your current password is required. The new address has to be confirmed
          before it works.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sentTo ? (
          /* The single most important thing to say here: nothing has changed
             yet. Someone who reads "email changed" and closes the tab without
             clicking the link has locked themselves out of their own system. */
          <Alert>
            <MailCheck className="size-4" />
            <AlertDescription className="grid gap-2">
              <span>
                Confirmation sent to <strong>{sentTo}</strong>. Open that inbox
                and click the link to finish.
              </span>
              <span className="font-medium">
                Your email has NOT changed yet. Keep signing in with{" "}
                <strong>{email}</strong> until you&apos;ve clicked that link — if
                you never do, nothing changes and your old address keeps working.
              </span>
              <span>
                <Button variant="outline" size="sm" onClick={() => setSentTo(null)}>
                  Change a different address
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="acc-em-pw">Current password</Label>
              <Input
                id="acc-em-pw"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="acc-new-em">New email</Label>
                <Input
                  id="acc-new-em"
                  type="email"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="acc-new-em2">Confirm new email</Label>
                <Input
                  id="acc-new-em2"
                  type="email"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={busy || !current || !next || !confirm}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                Send confirmation
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The lockout safety net. No re-auth gate here on purpose — the whole point is
 * that it works when you CAN'T prove who you are. It only ever mails the
 * address already on the account, so it hands nothing to anyone who isn't
 * already reading Jerry's inbox.
 */
function ResetCard({ email }: { email: string | null }) {
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function onSend() {
    if (!email) return;
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset`,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password reset email</CardTitle>
        <CardDescription>
          Sends a reset link to {email ?? "your address"}. This is also the
          &quot;Forgot password?&quot; link on the sign-in page — it&apos;s the
          way back in if you&apos;re ever locked out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <Alert>
            <MailCheck className="size-4" />
            <AlertDescription>
              Reset link sent to <strong>{email}</strong>. It expires after an
              hour — request another if it lapses.
            </AlertDescription>
          </Alert>
        ) : (
          <Button variant="outline" onClick={onSend} disabled={busy || !email}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
            Send password reset email
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
