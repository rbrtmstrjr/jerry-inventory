import type { Metadata } from "next";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Set a new password" };

/** Step 2 of recovery — /auth/callback already established the session, so only
 *  setting the password is left. Outside every route group by design. */
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
