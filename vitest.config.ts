import { defineConfig, type Plugin } from "vitest/config";

// Vite doesn't know about node:sqlite (experimental) — provide it via dynamic require.
const nodeSqlitePlugin: Plugin = {
  name: "vite-node-sqlite",
  enforce: "pre",
  resolveId(id) {
    if (id === "node:sqlite" || id === "sqlite") return "\0virtual:node-sqlite";
    return null;
  },
  load(id) {
    if (id === "\0virtual:node-sqlite") {
      // Use createRequire to bypass vite's module resolution for the actual load.
      return [
        `import { createRequire } from "node:module";`,
        `const _require = createRequire(import.meta.url);`,
        `const _sqlite = _require("node:sqlite");`,
        `export const DatabaseSync = _sqlite.DatabaseSync;`,
        `export const StatementSync = _sqlite.StatementSync;`,
        `export const backup = _sqlite.backup;`,
        `export const constants = _sqlite.constants;`,
        `export default _sqlite;`,
      ].join("\n");
    }
    return null;
  },
};

export default defineConfig({
  plugins: [nodeSqlitePlugin],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
