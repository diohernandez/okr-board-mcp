import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { SnapshotMetricResolver, FileMetricValueSnapshotLoader, type MetricValueSnapshot, type MetricValueSnapshotLoader } from "../src/metric-resolver";

const execFileAsync = promisify(execFile);
async function repoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));

class FakeLoader implements MetricValueSnapshotLoader {
  calls = 0;
  constructor(private snapshot: MetricValueSnapshot) {}
  async load() { this.calls++; return this.snapshot; }
}

const snapshot: MetricValueSnapshot = {
  fetched_at: "2026-07-30T00:00:00-03:00",
  source: "test",
  values: { NMV: 100, "NMV|PERIOD=2026-06": 50, TRX_TOTAL: 999 },
};

async function main() {
  // 1. exact, sin filter
  {
    const r = new SnapshotMetricResolver(new FakeLoader(snapshot));
    const res = await r.resolve("NMV");
    ok(res.value === 100 && !res.error, "exacto sin filter: NMV -> 100");
  }

  // 2. con filter, case-insensitive en metric/filter key/value
  {
    const r = new SnapshotMetricResolver(new FakeLoader(snapshot));
    const res = await r.resolve("nmv", { period: "2026-06" });
    ok(res.value === 50, "con filter, case-insensitive: nmv+period=2026-06 -> 50");
  }

  // 3. filter que no matchea ninguna combinación sembrada -> null + error, sin lanzar
  {
    const r = new SnapshotMetricResolver(new FakeLoader(snapshot));
    const res = await r.resolve("NMV", { period: "2099-01" });
    ok(res.value === null && !!res.error, "filter sin match: value null + error, no lanza");
  }

  // 4. métrica inexistente -> null + error
  {
    const r = new SnapshotMetricResolver(new FakeLoader(snapshot));
    const res = await r.resolve("METRICA_INVENTADA");
    ok(res.value === null && !!res.error, "métrica inventada: value null + error");
  }

  // 5. TTL: no releer dentro de la ventana
  {
    let now = 1_000_000;
    const loader = new FakeLoader(snapshot);
    const r = new SnapshotMetricResolver(loader, { ttlMs: 5000, now: () => now });
    await r.resolve("NMV");
    now += 4000;
    await r.resolve("NMV");
    ok(loader.calls === 1, "TTL: dentro de la ventana no vuelve a leer (1 carga)");
  }

  // 6. TTL: releer pasada la ventana
  {
    let now = 1_000_000;
    const loader = new FakeLoader(snapshot);
    const r = new SnapshotMetricResolver(loader, { ttlMs: 5000, now: () => now });
    await r.resolve("NMV");
    now += 6000;
    await r.resolve("NMV");
    ok(loader.calls === 2, "TTL: vencida la ventana, vuelve a leer (2 cargas)");
  }

  // 7. integración real: data/metric-values-snapshot.json
  {
    const snapshotPath = join(await repoRoot(), "data", "metric-values-snapshot.json");
    const r = new SnapshotMetricResolver(new FileMetricValueSnapshotLoader(snapshotPath));
    const res = await r.resolve("NMV");
    ok(res.value === 207661.19, "snapshot real: NMV resuelve al valor sembrado");
    const missing = await r.resolve("METRICA_QUE_NO_ESTA");
    ok(missing.value === null && !!missing.error, "snapshot real: métrica no sembrada -> null + error");
  }

  console.log(`\n${pass} OK · ${fail} FALLO`);
  if (fail) process.exit(1);
}

main();
