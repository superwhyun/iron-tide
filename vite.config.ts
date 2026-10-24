import { defineConfig } from "vite";
const apiPort = process.env.API_PORT ?? "3000";
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      "/health": `http://127.0.0.1:${apiPort}`,
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: "index.html", admin: "admin.html" },
      output: { manualChunks: { three: ["three"] } },
    },
  },
});
