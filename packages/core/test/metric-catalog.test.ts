import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { CachedMetricCatalog, FileMetricSnapshotLoader, type MetricSnapshot, type MetricSnapshotLoader } from "../src/metric-catalog";

const execFileAsync = promisify(execFile);
// No asumir cwd == raíz del repo: npm workspaces corre "npm test --workspace=core"
// con cwd = packages/core, no la raíz. Resolver con git en vez de contar "..".
async function repoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));

class FakeLoader implements MetricSnapshotLoader {
  calls = 0;
  constructor(private snapshot: MetricSnapshot) {}
  async load() { this.calls++; return this.snapshot; }
}

const snapshot: MetricSnapshot = {
  fetched_at: "2026-07-30T00:00:00-03:00",
  source: "test",
  exact: ["NMV", "TRX_TOTAL"],
  prefixes: ["GROSS_PROFIT_SIN_REFUSA_"],
};

async function main() {
  // 1. exact match, case-insensitive en ambos sentidos
  {
    const catalog = new CachedMetricCatalog(new FakeLoader(snapshot));
    ok(await catalog.has("NMV"), "exact: NMV existe");
    ok(await catalog.has("nmv"), "exact: 'nmv' (minúscula) matchea NMV");
  }

  // 2. prefijo paramétrico
  {
    const catalog = new CachedMetricCatalog(new FakeLoader(snapshot));
    ok(await catalog.has("GROSS_PROFIT_SIN_REFUSA_WEB"), "prefijo: GROSS_PROFIT_SIN_REFUSA_WEB matchea por prefijo");
    ok(await catalog.has("gross_profit_sin_refusa_meli_usd"), "prefijo: case-insensitive también en el prefijo");
  }

  // 3. no existe
  {
    const catalog = new CachedMetricCatalog(new FakeLoader(snapshot));
    ok(!(await catalog.has("METRICA_INVENTADA")), "no existe: METRICA_INVENTADA -> false");
  }

  // 4. TTL: no releer el loader dentro de la ventana
  {
    let now = 1_000_000;
    const loader = new FakeLoader(snapshot);
    const catalog = new CachedMetricCatalog(loader, { ttlMs: 5000, now: () => now });
    await catalog.has("NMV");
    now += 4000;
    await catalog.has("NMV");
    ok(loader.calls === 1, "TTL: dentro de la ventana no vuelve a leer el snapshot (1 sola carga)");
  }

  // 5. TTL: releer después de vencer la ventana
  {
    let now = 1_000_000;
    const loader = new FakeLoader(snapshot);
    const catalog = new CachedMetricCatalog(loader, { ttlMs: 5000, now: () => now });
    await catalog.has("NMV");
    now += 6000;
    await catalog.has("NMV");
    ok(loader.calls === 2, "TTL: vencida la ventana, vuelve a leer el snapshot (2 cargas)");
  }

  // 6. integración real: lee el snapshot sembrado en data/metric-catalog.json
  {
    const snapshotPath = join(await repoRoot(), "data", "metric-catalog.json");
    const catalog = new CachedMetricCatalog(new FileMetricSnapshotLoader(snapshotPath));
    ok(await catalog.has("NMV"), "snapshot real: NMV está sembrado en data/metric-catalog.json");
    ok(await catalog.has("GROSS_PROFIT_SIN_REFUSA_WEB"), "snapshot real: familia de profit matchea por prefijo");
    ok(!(await catalog.has("METRICA_INVENTADA")), "snapshot real: métrica inventada no existe");
  }

  console.log(`\n${pass} OK · ${fail} FALLO`);
  if (fail) process.exit(1);
}

main();
