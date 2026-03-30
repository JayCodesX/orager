import { defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: {
    // Point esbuild at a tsconfig that doesn't depend on the missing base
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Default timeout raised from 5s to 15s to prevent flakes in resource-
    // constrained CI environments where full-suite parallelism causes contention.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/daemon.ts"],
    },
  },
});
