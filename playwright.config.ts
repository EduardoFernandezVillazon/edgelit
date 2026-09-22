import { defineConfig } from '@playwright/test'

// Chromium for portable CI. The real Tauri engine (system WebKitGTK) is
// covered by test/webkitgtk/run.py, which needs a Linux desktop session.
export default defineConfig({
  testDir: 'test/browser',
  timeout: 60_000,
  use: { viewport: { width: 1000, height: 700 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist'] } } }],
  webServer: { command: 'npx vite --config demo/vite.config.ts --port 5180', port: 5180, reuseExistingServer: true },
})
