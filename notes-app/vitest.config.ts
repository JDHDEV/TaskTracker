import { defineConfig } from "vitest/config";

// Pure-helper unit tests only (no DOM, no Tauri). Node environment — no jsdom.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest disables CSS processing by default (any `?raw`/`?url` request
    // matching `\.css(\?|$)` is short-circuited to `export default ""`,
    // discarding whatever the real file content is) — re-enable it for the
    // `?raw` import stylesGuard.test.ts uses to read styles.css verbatim.
    css: { include: [/\?raw$/] },
  },
});
