import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitSpecStore } from "../src/git-store";
import { runWrite, ConcurrencyError, NotFoundError, type OkrBoardSpec, type MetricCatalog, type PipelineDeps } from "../src/pipeline";

const execFileAsync = promisify(execFile);

function baseSpec(): OkrBoardSpec {
  return {
    doc: { id: "board-2026", type: "okr-board", title: "Test", version: 1,
      updated_at: "2026-07-30T00:00:00-03:00", access: "domain",
      acl: [{ principal: "@dionisio", role: "owner" }] },
    pilares: [{ id: "p1", nombre: "Rentabilidad", desc: "", okrIds: ["o1"] }],
    negocios: [{ id: "n1", nombre: "Ecommerce AR" }],
    plataformas: [],
    objetivos: [{ id: "o1", negocioId: "n1", nombre: "Utilidad", texto: "..." }],
    krs: [{ id: "k1", objId: "o1", desc: "KR", sentido: "mayor", unidad: "%", target: 10,
      value: { mode: "literal", actual: 7.66, prev: 7.8, as_of: "2026-07-30" } }],
    rocas: [{ id: "r1", nombre: "Roca uno", detalle: "", area: "Comercial", equipo: null,
      trimestre: "Q3", estado: "no_iniciada", columna: "Prioridades Q3", krIds: ["k1"], pilarIds: ["p1"] }],
    kpis: [], iniciativas: [], onePager: [],
  };
}

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));
async function reject(fn: () => Promise<unknown>, E: Function, l: string) {
  try { await fn(); ok(false, l + " (no lanzó)"); }
  catch (e) { ok(e instanceof E, l + (e instanceof E ? "" : ` (lanzó ${(e as Error).constructor.name})`)); }
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), "specstore-"));
  await execFileAsync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  // primer commit vacío para que exista HEAD
  await execFileAsync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "-q", "--allow-empty", "-m", "root"]);

  const store = new GitSpecStore({ repoDir: repo, committer: { name: "mcp", email: "mcp@bidcom.local" } });
  const catalog: MetricCatalog = { async has(m) { return ["nmv", "utilidad_gni"].includes(m); } };
  const deps: PipelineDeps = { store, catalog, now: () => "2026-07-30T12:00:00-03:00" };

  // 1. init crea el doc y devuelve versión
  const v1 = await store.init("board-2026", baseSpec(), "bootstrap");
  ok(typeof v1 === "string" && v1.length >= 7, "init crea el doc y devuelve un sha de versión");

  // 2. readHead devuelve spec + esa versión
  const head = await store.readHead("board-2026");
  ok(head.version === v1 && head.spec.rocas[0].estado === "no_iniciada", "readHead devuelve spec + versión de HEAD");

  // 3. commit con versión correcta -> nueva versión distinta
  const changed = baseSpec(); changed.rocas[0].estado = "completada";
  const v2 = await store.commit("board-2026", changed, "roca r1 completada", v1);
  ok(v2 !== v1, "commit con base_version correcta -> versión nueva (v1 != v2)");
  const head2 = await store.readHead("board-2026");
  ok(head2.spec.rocas[0].estado === "completada" && head2.version === v2, "el cambio quedó persistido en HEAD");

  // 4. commit con versión desactualizada -> ConcurrencyError
  await reject(() => store.commit("board-2026", baseSpec(), "stale", v1), ConcurrencyError,
    "commit con base_version stale -> ConcurrencyError");

  // 5. no-op: commitear el mismo contenido con la versión actual -> misma versión, sin commit nuevo
  const before = await countCommits(repo);
  const same = await store.commit("board-2026", head2.spec, "sin cambios", v2);
  const after = await countCommits(repo);
  ok(same === v2 && before === after, "commit de contenido idéntico es no-op (no crea commit)");

  // 6. readHead de doc inexistente -> NotFoundError
  await reject(() => store.readHead("no-existe"), NotFoundError, "readHead de doc inexistente -> NotFoundError");

  // 7. path traversal bloqueado
  await reject(() => store.readHead("../../etc/passwd" as string), Error, "docId con traversal -> Error (bloqueado)");

  // 8. integración real con el pipeline: runWrite usando el store git de verdad
  {
    const { version } = await runWrite(deps, "@dionisio", "board-2026", v2,
      { op: "set_kr_value", krId: "k1", value: { mode: "metric", metric: "nmv", filter: { period: "2026-06" } } });
    const h = await store.readHead("board-2026");
    ok(version !== v2 && h.spec.krs[0].value.mode === "metric",
      "runWrite (pipeline completo) escribe a git: k1 migrado a metric(nmv)");
  }

  // 9. el historial existe (versionado real)
  const commits = await countCommits(repo);
  ok(commits >= 4, `git tiene historial de versiones (${commits} commits): root + init + completada + set_kr_value`);

  console.log(`\n${pass} OK · ${fail} FALLO`);
  await rm(repo, { recursive: true, force: true });
  if (fail) process.exit(1);
}

async function countCommits(repo: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-list", "--count", "HEAD"]);
  return Number(stdout.trim());
}

main();
