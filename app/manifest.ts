import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Maccky's Marine Inventory",
    short_name: "Maccky's Marine",
    description: "Multi-shop inventory and sales-approval system",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfaf9",
    theme_color: "#1e5a96",
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
