import type { NextConfig } from "next";

const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
  : "*.supabase.co";

const nextConfig: NextConfig = {
  experimental: {
    // `dynamic` defaults to 0s, so every page re-ran on back-navigation. Safe at
    // 30s here: every mutation revalidatePath()s, which clears the router cache.
    staleTimes: { dynamic: 30, static: 180 },
  },
  async redirects() {
    return [
      {
        // A config redirect gives a REAL 307, unlike the page-level redirect()
        // stubs Next 16 serves as 200 + meta refresh. Query params pass through.
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
