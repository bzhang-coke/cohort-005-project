import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { realpathSync } from "node:fs";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  // This throwaway worktree may share the main checkout's installed dependencies.
  server: { fs: { allow: [process.cwd(), realpathSync("node_modules")] } },
});
