import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    // Comma-separated hostnames for tunnels used during local webhook testing.
    // Read with loadEnv rather than from process.env: this file is evaluated
    // before Vite loads .env, so a hostname set there would silently not apply
    // and every tunneled request would get Vite's "host is not allowed" 403.
    allowedHosts: (loadEnv(mode, process.cwd(), "VITE_").VITE_ALLOWED_HOSTS ?? "")
      .split(",").map((host) => host.trim()).filter(Boolean),
    port: 4173,
    proxy: {
      "/api": "http://localhost:4174",
      // The API server owns sign-in. Without these the dev server would answer
      // /login with the SPA, which redirects to /login again on the next 401.
      "/login": "http://localhost:4174",
      "/logout": "http://localhost:4174",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    globals: true,
    // Pinned so the suite always exercises the Agent Studio chat path. Left to
    // a developer's .env, the same tests would silently cover the local
    // fallback chat instead, and CI would test something different again.
    env: {
      VITE_ALGOLIA_APPLICATION_ID: "test-application-id",
      VITE_ALGOLIA_SEARCH_API_KEY: "test-search-api-key",
      VITE_ALGOLIA_AGENT_ID: "test-agent-id",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // main.tsx only mounts the tree, and App.tsx is a one-line re-export.
      exclude: ["src/main.tsx", "src/App.tsx", "src/**/*.d.ts"],
      // A ratchet, not an aspiration: these track what the suite actually
      // covers today so a regression fails CI. Raise them alongside new tests.
      thresholds: { lines: 67, functions: 53, branches: 52, statements: 63 },
    },
  },
}));
