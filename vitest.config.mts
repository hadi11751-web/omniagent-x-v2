import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  oxc: {
    // tsconfig keeps `jsx: "preserve"` for Next's own compiler, which leaves a
    // component import unparseable here. Only the render tests need this.
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "node",
  },
});

