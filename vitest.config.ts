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
  },
});
