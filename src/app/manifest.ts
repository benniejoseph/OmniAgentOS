import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Asael — Personal Agent Arsenal",
    short_name: "Asael",
    description: "A private second brain and adaptive AI agent workspace.",
    start_url: "/app",
    display: "standalone",
    background_color: "#0b0d0c",
    theme_color: "#13c98b",
    orientation: "any",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/asael-mark.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/asael-mark.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "/app/capture",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  } as MetadataRoute.Manifest;
}
