import { defineConfig } from "vitest/config";

// AUTHORED-BY Claude Opus 4.8
// Test config kept separate from vite.config.ts: vitest ships its own nested
// `vite` copy, and mixing the react plugin's `vite` types with vitest's pulls in
// a dual-vite type clash. No plugin here — the unit suite needs only jsdom.
export default defineConfig({
  // Disable PostCSS: the parent Django repo ships a root postcss.config.js that
  // vitest would otherwise walk up to and try to load (its `cssnano` isn't
  // installed in this isolated SPA workspace). The unit suite doesn't process CSS.
  css: { postcss: { plugins: [] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
