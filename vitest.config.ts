import { defineConfig } from "vitest/config";

/**
 * Convex function tests (tests/convex). They run the real Convex functions
 * against convex-test's in-memory backend, in the edge runtime Convex uses.
 * The signing/interop unit tests in tests/*.test.ts use node:test instead.
 */
export default defineConfig({
  test: {
    include: ["tests/convex/**/*.test.ts"],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
