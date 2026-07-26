import type { NextConfig } from "next";

const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
  : "*.supabase.co";

const nextConfig: NextConfig = {
  experimental: {
    // Client Router Cache. `dynamic` defaults to 0s in Next 15+, so every page
    // here (all dynamic — they read cookies() for auth) re-ran its server
    // component on every back-navigation. 30s makes returning to a page you
    // just left instant. Safe for this app: mutations go through server actions
    // that call revalidatePath(), which invalidates the router cache, so a
    // stale slot can never survive a change the user actually made.
    staleTimes: { dynamic: 30, static: 180 },
  },
  async redirects() {
    return [
      {
        // Receiving moved to Suppliers (it's a supplier transaction). A config
        // redirect gives a REAL 307 — unlike the page-level redirect() stubs,
        // which Next 16 serves to a document GET as a 200 + meta refresh.
        // Extra query params (?view=<id>) pass through automatically.
        source: "/master-inventory/receiving",
        destination: "/suppliers?tab=receiving",
        permanent: false,
      },
    ];
  },
  images: {
    // Product images live in Supabase Storage (public bucket); next/image
    // handles per-context resizing + lazy loading.
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHost,
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
