import type { NextConfig } from "next";

const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
  : "*.supabase.co";

const nextConfig: NextConfig = {
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
