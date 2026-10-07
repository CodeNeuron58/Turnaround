import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api proxies to the prediction service so the browser never fights CORS
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from the phone: same Wi-Fi, or a private network on the trail
    // IPs are always allowed; this admits Tailscale MagicDNS names (laptop.tailnet.ts.net)
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
