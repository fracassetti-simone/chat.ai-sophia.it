import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: ["chat.ai-sophia.it"],
    proxy: {
      "/api": {
        target: "https://api.ai-sophia.it",
        changeOrigin: true
      },
      "/socket.io": {
        target: "https://api.ai-sophia.it",
        changeOrigin: true,
        ws: true
      }
    }
  }
});
