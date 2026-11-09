import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // near-api-js pulls in the npm `util` package, which reads this at load. Builds already replace process.env; dev doesn't.
  define: { "process.env.NODE_DEBUG": "false" },
});
