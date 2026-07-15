import { defineConfig } from "vitest/config";

// Pure-helper unit tests only (no DOM, no Tauri). Node environment — no jsdom.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
