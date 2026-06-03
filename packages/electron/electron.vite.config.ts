import { resolve } from "path"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

const forceExternal = {
  name: "force-external",
  enforce: "pre" as const,
  resolveId(source: string) {
    const externals = ["node-pty", "@agentterm/shared", "@agentterm/server", "express", "ws"]
    for (const ext of externals) {
      if (source === ext || source.startsWith(ext + "/")) {
        return { id: source, external: true }
      }
    }
    return null
  },
}

export default defineConfig({
  main: {
    plugins: [forceExternal],
  },
  preload: {},
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
})
