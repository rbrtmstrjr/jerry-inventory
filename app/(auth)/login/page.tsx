import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Cog } from "lucide-react";

import { getProfile } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { ThemeToggle } from "./theme-toggle";

export const metadata: Metadata = { title: "Sign in" };

// Backdrop photos (crossfaded). Served as CSS backgrounds — not next/image — so
// no remotePatterns entry is needed; Pexels params keep the download small.
const BG_IMAGES = [
  "https://images.pexels.com/photos/36747628/pexels-photo-36747628.jpeg?auto=compress&cs=tinysrgb&w=1400",
  "https://images.pexels.com/photos/13118946/pexels-photo-13118946.jpeg?auto=compress&cs=tinysrgb&w=1400",
  "https://images.pexels.com/photos/36033665/pexels-photo-36033665.jpeg?auto=compress&cs=tinysrgb&w=1400",
];

// One headline per backdrop photo — crossfades in step with BG_IMAGES.
const SLIDES = [
  {
    title: "Engines, parts, and every branch — in sync.",
    body: "Central stock, guided deliveries, and sales approved before anything moves.",
  },
  {
    title: "Nothing leaves the shelf unapproved.",
    body: "Every sale and loss clears your review before stock deducts — across all shops.",
  },
  {
    title: "One ledger for the whole trade.",
    body: "Master, transit, and branch stock reconciled to the last unit.",
  },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in? Go straight to the right home.
  const profile = await getProfile().catch(() => null);
  if (profile) redirect(profile.role === "owner" ? "/dashboard" : "/shop");

  // /auth/callback bounces failed reset links back here with a plain-language
  // reason, so a dead link explains itself instead of silently doing nothing.
  const { error } = await searchParams;

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Brand panel — text over an animated photographic backdrop. Deliberately
          dark (scrim) so white copy stays high-contrast in both themes. Hidden
          on small screens, where a compact header stands in. */}
      <aside className="relative isolate hidden flex-col justify-end overflow-hidden p-10 text-white lg:flex xl:p-14">
        {/* Animated backdrop: a static base (also the reduced-motion fallback)
            with three crossfading, slowly zooming layers over it. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-20 bg-slate-950 bg-cover bg-center"
          style={{ backgroundImage: `url(${BG_IMAGES[0]})` }}
        >
          {BG_IMAGES.map((src, i) => (
            <div
              key={src}
              className="absolute inset-0 bg-cover bg-center opacity-0 [animation:login-bg_24s_ease-in-out_infinite] motion-reduce:hidden"
              style={{ backgroundImage: `url(${src})`, animationDelay: `${i * 8}s` }}
            />
          ))}
        </div>
        {/* Legibility scrim — accent blue, bottom-heavy, so the subject up top
            stays clear while the text below stays readable. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-gradient-to-t from-blue-700/90 via-blue-600/45 to-transparent"
        />

        {/* Foreground — bottom-anchored so the photo subject reads up top. The
            headline rotates in step with the backdrop; the feature list stays
            put. A soft shadow keeps text legible over any frame. */}
        <div className="relative max-w-lg [text-shadow:0_1px_10px_rgb(2_6_23/0.55)]">
          {/* Rotating headline — slides share one grid cell so nothing shifts. */}
          <div className="grid">
            {SLIDES.map((slide, i) => (
              <div
                key={slide.title}
                className="col-start-1 row-start-1 opacity-0 [animation:login-fade_24s_ease-in-out_infinite] motion-reduce:animate-none first:motion-reduce:opacity-100"
                style={{ animationDelay: `${i * 8}s` }}
              >
                <h1 className="text-5xl font-extrabold leading-[1.05] tracking-tight xl:text-6xl">
                  {slide.title}
                </h1>
                <p className="mt-5 text-pretty text-lg text-white/85 xl:text-xl">
                  {slide.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-8 text-xs text-white/70">
          © {new Date().getFullYear()} Gerwin Trading
        </p>
      </aside>

      {/* Form panel — theme-aware. */}
      <main className="relative flex flex-col bg-background">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
          <div className="w-full max-w-sm">
            {/* Brand header — lives beside the form on every screen, sized to
                match the wordmark that used to sit on the brand panel. */}
            <div className="mb-8 flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Cog className="size-6" />
              </div>
              <div className="leading-tight">
                <div className="text-lg font-semibold tracking-tight">
                  Gerwin Trading
                </div>
                <div className="text-sm text-muted-foreground">
                  Inventory &amp; Approvals
                </div>
              </div>
            </div>

            <LoginForm initialError={error} />
          </div>
        </div>
      </main>
    </div>
  );
}
