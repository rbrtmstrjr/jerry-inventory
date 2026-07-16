import type { Metadata } from "next";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Set a new password" };

/**
 * Step 2 of recovery: /auth/callback has already exchanged the emailed code for
 * a session, so by the time we get here the user IS signed in — they just can't
 * remember the password. Setting one is all that's left.
 *
 * Outside every route group, so no owner/shop gate runs. Recovery has to work
 * for whoever holds the link.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session means the code exchange never happened — a link opened straight
  // from an old email, expired, or already spent. Say what to do about it.
  if (!user) {
    return (
      <div className="mx-auto flex min-h-svh max-w-md items-center p-4">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>This reset link has expired</CardTitle>
            <CardDescription>
              Reset links work once and last about an hour. Request a fresh one
              from the sign-in page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/login">Back to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-md items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>
            For <strong>{user.email}</strong>. Once you save it you&apos;ll be
            taken straight in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetForm />
        </CardContent>
      </Card>
    </div>
  );
}
