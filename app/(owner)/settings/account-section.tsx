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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
/**
 * Auth errors are not always readable. When GoTrue fails on something that
 * happens BEHIND the request — an SMTP send that the mail provider rejects is
 * the common one — it can answer with a non-2xx and an EMPTY body, and the
 * client surfaces that as the literal string "{}". A toast reading `{}` tells
 * the owner nothing and reads like the app is broken.
 *
 * So: use the real message when there is one, and otherwise say what actually
 * went wrong and where to look, with whatever status/code we did get.
 */
function authErrorText(error: unknown): string {
  const e = error as { message?: string; status?: number; code?: string } | null;
  const raw = (e?.message ?? "").trim();
  if (raw && raw !== "{}" && raw !== "[object Object]") return raw;

  const detail = [e?.code, e?.status != null ? `HTTP ${e.status}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    "The server rejected that request" +
    (detail ? ` (${detail})` : "") +
    ". This is usually the confirmation email failing to send — check the " +
    "email provider's logs and the SMTP settings."
  );
}

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
      toast.error(authErrorText(error));
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

  // /auth/confirm sends the owner back here when ONE of the two links has been
  // accepted but the change is still waiting on the other. Read it off the URL
  // rather than guessing — the route is the only thing that knows.
  const [halfDone, setHalfDone] = React.useState(false);
  React.useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("emailchange") === "pending") {
      setHalfDone(true);
      p.delete("emailchange"); // don't let a refresh re-show it
      const q = p.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
    }
  }, []);

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
    // Send the confirmation link to OUR route rather than letting it fall back
    // to the Site URL. Without this the link goes through Supabase's own verify
    // endpoint and, when the token has expired or a mail scanner already opened
    // it, dumps the user on the homepage with a bare "Access denied" fragment.
    const { error } = await supabase.auth.updateUser(
      { email: next },
      // Deliberately NO query string: the email template appends
      // `?token_hash=…&type=…` to this value, so it has to be a bare URL.
      // /auth/confirm sends an email_change back to Settings on its own.
      { emailRedirectTo: `${window.location.origin}/auth/confirm` }
    );
    setBusy(false);
    if (error) {
      toast.error(authErrorText(error));
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
        {/* "We sent you an email" is an OUTCOME, not a new state of this form,
            so it belongs in a dialog that interrupts and is dismissed — not as a
            panel that silently replaces the fields the owner was just using.
            The form stays mounted underneath, so closing this returns him
            exactly where he was. */}
        <Dialog open={sentTo !== null} onOpenChange={(o) => !o && setSentTo(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
                <MailCheck className="size-6 text-primary" aria-hidden />
              </div>
              <DialogTitle className="text-center">Check your inbox</DialogTitle>
              <DialogDescription className="text-center">
                We sent a confirmation link to <strong>{sentTo}</strong>.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 text-sm">
              {/* The one thing that must not be missed: nothing has changed yet.
                  Someone who reads "email sent", closes the tab and forgets can
                  otherwise believe he has locked himself out. */}
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <p className="font-medium">Your email hasn&apos;t changed yet.</p>
                <p className="mt-1 text-muted-foreground">
                  Keep signing in with <strong>{email}</strong> until you click
                  that link. If you never do, nothing changes.
                </p>
              </div>
              <p className="text-muted-foreground">
                The link works once and expires. You&apos;ll be signed out and
                asked to sign in with the new address once it&apos;s confirmed.
              </p>
            </div>

            <DialogFooter className="sm:justify-center">
              <Button onClick={() => setSentTo(null)}>Got it</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {halfDone && (
          <Alert className="mb-4">
            <MailCheck className="size-4" />
            <AlertDescription>
              <span className="font-medium">One link confirmed — one to go.</span>{" "}
              A link was also sent to your current address{" "}
              <strong>{email}</strong>. Click that one too and the change
              completes. Until then you keep signing in with{" "}
              <strong>{email}</strong>.
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="acc-em-pw">Current password</Label>
              {/* A password field plus an email field reads to Chrome as a
                  sign-in form, so it filled BOTH from a saved credential — the
                  New email box arrived pre-loaded with an address the owner had
                  never typed, one Send-confirmation click away from mailing the
                  wrong person. Suppressing it on the password too is not just
                  tidiness: this gate exists to prove someone is AT the keyboard
                  ("being signed in isn't enough"), which a browser-filled
                  password quietly defeats. */}
              <Input
                id="acc-em-pw"
                type="password"
                autoComplete="off"
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
                  autoComplete="off"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="acc-new-em2">Confirm new email</Label>
                <Input
                  id="acc-new-em2"
                  type="email"
                  autoComplete="off"
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
      toast.error(authErrorText(error));
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
