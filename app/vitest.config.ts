import { defineConfig } from "vitest/config";

// Dedicated config for logic unit tests — deliberately excludes the app's
// React/Tailwind Vite plugins so store/selector tests run fast in a plain
// node environment. Component tests (if added later) can switch to jsdom.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
