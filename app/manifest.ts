import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Gerwin Trading Inventory",
    short_name: "Gerwin Trading",
    description: "Multi-shop inventory and sales-approval system",
    start_url: "/",
    display: "standalone",
    // OS-level (install splash / address bar) — can't read CSS vars, so these
    // approximate the brand tokens by hand: bg ≈ --background, theme = --primary.
    background_color: "#f0f3fa",
    theme_color: "#0c45ff",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
