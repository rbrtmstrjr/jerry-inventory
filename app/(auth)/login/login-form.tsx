"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const [serverError, setServerError] = React.useState<string | null>(
    initialError ?? null
  );
  // Stays true after a successful sign-in so the button keeps its loading
  // state while the redirect + server render are still in flight.
  const [redirecting, setRedirecting] = React.useState(false);
  const [forgotOpen, setForgotOpen] = React.useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    setServerError(null);
    const supabase = createClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setServerError(
        error.message === "Invalid login credentials"
          ? "Wrong email or password."
          : error.message
      );
      return;
    }

    // Route by role (profiles row is created by the owner/seed).
    const { data: prof } = await supabase
      .from("profiles")
      .select("role, active")
      .eq("id", data.user.id)
      .single();

    if (!prof) {
      setServerError(
        "Your account has no profile yet. Ask the owner to set up your access."
      );
      await supabase.auth.signOut();
      return;
    }
    if (!prof.active) {
      setServerError("This account has been disabled. Talk to the owner.");
      await supabase.auth.signOut();
      return;
    }

    setRedirecting(true);
    router.push(prof.role === "owner" ? "/dashboard" : "/shop");
    router.refresh();
  }

  const loading = isSubmitting || redirecting;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use the account the owner created for you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register("email")}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            )}
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <button
                type="button"
                onClick={() => setForgotOpen(true)}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-sm text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading && <Loader2 className="size-4 animate-spin" />}
            {redirecting ? "Signing in…" : loading ? "Checking…" : "Sign in"}
          </Button>
        </form>
      </CardContent>

      {/* Mounted only while open, so it starts fresh every time and simply
          seeds itself from whatever email is already typed. The alternative —
          keeping it mounted and resetting in an effect — is a setState in an
          effect, which is a cascading render for no reason. */}
      {forgotOpen && (
        <ForgotPasswordDialog
          onOpenChange={setForgotOpen}
          defaultEmail={getValues("email")}
        />
      )}
    </Card>
  );
}

/**
 * The way back in. This is the only recovery path that works when nobody can
 * sign in — if it breaks, Jerry is locked out of his own business with no
 * support desk to call, so it stays as simple as it can possibly be.
 */
function ForgotPasswordDialog({
  onOpenChange,
  defaultEmail,
}: {
  onOpenChange: (v: boolean) => void;
  defaultEmail?: string;
}) {
  const [email, setEmail] = React.useState(defaultEmail ?? "");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSend() {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset`,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSent(true);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset your password</DialogTitle>
          <DialogDescription>
            We&apos;ll email you a link to set a new one.
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="grid gap-2 text-sm">
            {/* Deliberately does not confirm whether that address has an account
                — saying "no such user" would let anyone test addresses against
                this login. Supabase answers the same way for the same reason. */}
            <p>
              If <strong>{email}</strong> has an account, a reset link is on its
              way. It lasts about an hour.
            </p>
            <p className="text-muted-foreground">
              Open the link in this same browser — for security the link is tied
              to the browser that asked for it.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {sent ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button onClick={onSend} disabled={busy || !email}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Send reset link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
