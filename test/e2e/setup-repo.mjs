// =============================================================================
// setup-repo — bootstrap del repo git AISLADO que usan los tests E2E.
//
// NUNCA toca el repo real ni data/despliegue-estrategico-2026.json: crea un repo
// git nuevo en REPO_DIR (fijo, no vía os.tmpdir() -- dos procesos separados, este
// script y el server del API, necesitan coincidir en la misma ruta sin pasársela
// por ningún otro medio) con un spec mínimo pero válido contra el schema.
//
// El docId tiene que ser EXACTO ("despliegue-estrategico-2026"): apps/frontend/
// index.html lo tiene hardcodeado como constante (DOC_ID), no es configurable —
// así que el spec de prueba vive bajo ese mismo nombre en el repo aislado.
//
// Se llama encadenado dentro del comando del webServer del API en
// playwright.config.ts (`node setup-repo.mjs && node .../server.js`), no como
// globalSetup de Playwright -- así el orden (repo listo ANTES de que el server
// arranque) lo garantiza el shell, no un hook cuyo orden respecto a webServer no
// está documentado.
// =============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { GitSpecStore } from "core";

const execFileAsync = promisify(execFile);
export const REPO_DIR = "/tmp/okr-e2e-repo";
export const DOC_ID = "despliegue-estrategico-2026";

function baseSpec() {
  return {
    doc: {
      id: DOC_ID, type: "okr-board", title: "Fixture Test Board", version: 1,
      updated_at: "2026-01-01T00:00:00.000Z", access: "domain",
      acl: [{ principal: "@dionisio", role: "owner" }],
    },
    // Nombres "Fixture ..." a propósito, NUNCA "... E2E ...": los tests que crean
    // entidades dinámicas las nombran "... E2E <sufijo>" -- si el fixture usara la
    // misma palabra, un hasText:"E2E" (substring) matchea AMBOS y los selectores de
    // fila/card quedan ambiguos apenas un test anterior deja algo creado en el repo
    // compartido (encontrado corriendo esto de verdad).
    pilares: [{ id: "p1", nombre: "Pilar Fixture", desc: "Pilar de prueba", okrIds: ["o1"] }],
    negocios: [{ id: "n1", nombre: "Negocio Fixture" }],
    plataformas: [],
    objetivos: [{ id: "o1", negocioId: "n1", nombre: "Objetivo Fixture", texto: "Objetivo de prueba." }],
    krs: [{ id: "k1", objId: "o1", desc: "KR Fixture", sentido: "mayor", unidad: "%", target: 50,
      value: { mode: "literal", actual: 10 }, boards: [] }],
    rocas: [{ id: "r1", nombre: "Roca Fixture", detalle: "", area: "QA", equipo: null,
      trimestre: null, estado: "no_iniciada", columna: "Pendientes", krIds: [], pilarIds: [] }],
    kpis: [{ id: "kpi1", pilarId: "p1", negocioId: "n1", nombre: "KPI Fixture", sentido: "mayor",
      unidad: "%", target: 20, value: { mode: "literal", actual: 5 } }],
    iniciativas: [],
    onePager: [{ id: "op1", negocioId: "n1", grupo: "Rentabilidad", sentido: "mayor",
      nombre: "NMV Fixture", unidad: "M USD", target: 100, value: { mode: "literal", actual: 80 } }],
  };
}

async function main() {
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(REPO_DIR, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main", REPO_DIR]);
  await execFileAsync("git", [
    "-C", REPO_DIR, "-c", "user.name=e2e", "-c", "user.email=e2e@test",
    "commit", "-q", "--allow-empty", "-m", "root",
  ]);
  const store = new GitSpecStore({ repoDir: REPO_DIR, committer: { name: "e2e", email: "e2e@test" } });
  await store.init(DOC_ID, baseSpec(), "bootstrap e2e");
  console.log(`setup-repo: listo en ${REPO_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
