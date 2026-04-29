import { defineConfig } from "tsup";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Build configuration for personal-asistent.
 *
 * Two modes (PERF-11):
 * - Development (default): sourcemaps enabled, no minification — readable stack traces
 * - Production (NODE_ENV=production): minified bundle (~33% smaller), no sourcemaps
 *
 * Usage:
 *   bun run build          → development build (sourcemaps, no minify)
 *   bun run build:prod     → production build (minified, no sourcemaps)
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  bundle: true,
  splitting: false,
  sourcemap: !isProduction,
  minify: isProduction,
  clean: true,
  // bun:sqlite is a Bun built-in — cannot be bundled; all npm deps are bundled into the output
  external: ["bun:sqlite"],
  banner: {
    // npm/npx compatibility; Bun ≥1.3.5 is still REQUIRED at runtime (bun:sqlite)
    js: "#!/usr/bin/env node",
  },
});
