import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 15000,
    baseURL: "http://127.0.0.1:5175",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx tests/support/fakeMetanomic.ts 3390",
      url: "http://127.0.0.1:3390/health",
      reuseExistingServer: false,
    },
    {
      command:
        "PORT=3100 E2E_SECRET=local-browser-verification ACCOUNT_DB=:memory: METANOMIC_API_URL=http://127.0.0.1:3390/v1 METANOMIC_GAME_ID=game-test METANOMIC_GAME_KEY=test-game-key ADMIN_SETUP_CODE=TEST-0001 npx tsx server/index.ts",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
    },
    {
      command:
        "API_PORT=3100 npx vite --host 127.0.0.1 --port 5175 --strictPort",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
    },
  ],
});
