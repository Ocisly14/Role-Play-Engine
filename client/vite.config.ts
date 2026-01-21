import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiUrl = process.env.API_URL || "http://localhost:3000";
const apiOrigin = new URL(apiUrl).origin;
const wsOrigin = apiOrigin.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    host: true,
    allowedHosts: ["game.coc-agent.com"],
    hmr: {
      overlay: true,
    },
    watch: {
      usePolling: true,
    },
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: wsOrigin,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
