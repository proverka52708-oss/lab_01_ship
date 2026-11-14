import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "client/tests/**/*.test.ts",
      "server/test/**/*.test.ts",
      "shared/test/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts"],
      exclude: ["shared/src/**/*.d.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
