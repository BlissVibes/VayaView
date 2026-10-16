import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { parlorApi } from "./server/parlor-api.mjs";

export default defineConfig({
  plugins: [react(), tailwindcss(), parlorApi()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist-web", emptyOutDir: true },
  // Localhost only. Nothing listens on the network.
  server: { host: "127.0.0.1", port: 5178 },
});
