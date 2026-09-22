import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { edgelit: resolve(__dirname, '../src/index.ts') } },
  server: { port: 5180 },
  build: { outDir: resolve(__dirname, '../dist-demo'), target: 'es2022' },
})
