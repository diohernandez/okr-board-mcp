import { defineConfig } from "@playwright/test";

// E2E de F4 (apps/frontend escribiendo de verdad contra packages/api) — ver
// CLAUDE.md §2.4/§2.5. Corre contra un repo git AISLADO (test/e2e/setup-repo.mjs),
// nunca contra data/despliegue-estrategico-2026.json real: nada de lo que hace esta
// suite puede dejar un commit ni un dato de prueba en el board real.
//
// workers:1 / fullyParallel:false a propósito: todos los tests comparten el MISMO
// doc (como cualquier escritor real contra GitSpecStore) — correrlos en paralelo
// competiría por base_version entre tests sin ninguna razón real para probar eso
// acá (el lock multi-proceso ya tiene su propio test en packages/core).
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8789",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // setup-repo encadenado ANTES del server: garantiza el orden vía el shell,
      // no vía un hook de Playwright cuyo orden respecto a webServer no está
      // documentado (ver comentario de setup-repo.mjs).
      command: "node test/e2e/setup-repo.mjs && node packages/api/dist/src/server.js",
      url: "http://localhost:8788/api/boards/despliegue-estrategico-2026/version",
      env: { OKR_REPO_ROOT: "/tmp/okr-e2e-repo", PORT: "8788" },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Estático, no toca datos -- sirve apps/frontend/index.html tal cual (mismo
      // proceso que en local, ver scripts/serve-frontend.ts). No necesita
      // OKR_REPO_ROOT: no lee del repo, solo del filesystem de apps/frontend.
      command: "node scripts/dist/serve-frontend.js",
      url: "http://localhost:8789/",
      env: { PORT: "8789" },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
