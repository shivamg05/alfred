import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    testTimeout: 10_000,
    // Each test file gets its own worker so in-memory DBs don't collide
    pool: "forks",
  },
});
