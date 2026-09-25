import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __CLIENT_ID__: JSON.stringify("test-client-id"),
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/obsidian-mock.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
