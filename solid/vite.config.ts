import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// AUTHORED-BY Claude Opus 4.8
// Linkding-Solid is a static SPA — built to /dist for a zero-cost static host
// (Vercel free tier / any CDN). No server, no Django.
export default defineConfig({
  plugins: [react()],
  // Inline PostCSS (empty) so Vite does not walk up to the parent Django repo's
  // root postcss.config.js (which requires cssnano, absent in this SPA workspace).
  css: { postcss: { plugins: [] } },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
