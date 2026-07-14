import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite options tailored for Tauri development.
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
