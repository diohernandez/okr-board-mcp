// =============================================================================
// refresh-metrics — mecanismo de refresh on-demand para KRs/KPIs en mode:"metric"
//
// El día que un valor se resuelve "en vivo" contra el Bidcom Analytics MCP real
// (lookup/get_data_context/query_analytics) es cuando Claude corre este flujo a
// mano — no hay cron todavía (ver CLAUDE.md, mejora "MetricCatalog conectado a
// la capa semántica"). Dos subcomandos, sin lógica de resolución acá: resolver el
// SQL/valor de cada métrica requiere un LLM (el Analytics MCP está diseñado para
// eso, no para que un script determinístico le mande SQL a ciegas).
//
//   list                    -> lee el spec, devuelve los {metric, filter} distintos
//                               que están en mode:"metric", agrupados por clave
//                               canónica (misma que usa MetricResolver). Con esto
//                               Claude sabe qué resolver.
//   apply <values.json>     -> values.json: { "<claveCanonica>": <numero>, ... }.
//                               Mergea esos valores en data/metric-values-snapshot.json
//                               (no pisa claves no incluidas — así conviven fixtures
//                               de test con valores reales, ver el "source" del
//                               propio snapshot).
//
// canonicalKey() duplica a propósito la de packages/api/src/metric-resolver.ts:
// scripts/ no depende de packages/api (no es su consumidor natural) y es lógica
// mínima (mayúsculas + join ordenado). Si aparece un tercer consumidor, extraer a
// core en vez de duplicar de nuevo.
// =============================================================================

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOC_ID = "despliegue-estrategico-2026";
const SPEC_PATH = join(ROOT, "data", `${DOC_ID}.json`);
const SNAPSHOT_PATH = join(ROOT, "data", "metric-values-snapshot.json");

function canonicalKey(metric: string, filter?: Record<string, string>): string {
  const base = metric.toUpperCase();
  if (!filter || Object.keys(filter).length === 0) return base;
  const parts = Object.keys(filter).sort().map(k => `${k.toUpperCase()}=${filter[k].toUpperCase()}`);
  return `${base}|${parts.join("&")}`;
}

interface MetricRef {
  canonicalKey: string;
  metric: string;
  filter: Record<string, string>;
  usedBy: string[];
  warning?: string;
}

// Recorre krs/kpis/iniciativas.hitos/onePager buscando value.mode==="metric".
// No mira pilares/negocios/plataformas/objetivos/rocas: esas entidades no tienen
// "value" gobernable (ver schema).
function collectMetricRefs(spec: any): MetricRef[] {
  const refs = new Map<string, MetricRef>();
  function visit(value: any, label: string) {
    if (!value || value.mode !== "metric") return;
    const key = canonicalKey(value.metric, value.filter);
    if (!refs.has(key)) refs.set(key, { canonicalKey: key, metric: value.metric, filter: value.filter ?? {}, usedBy: [] });
    refs.get(key)!.usedBy.push(label);
  }
  for (const kr of spec.krs ?? []) visit(kr.value, `krs/${kr.id}`);
  for (const kpi of spec.kpis ?? []) visit(kpi.value, `kpis/${kpi.id}`);
  for (const ini of spec.iniciativas ?? []) {
    (ini.hitos ?? []).forEach((h: any, idx: number) => visit(h.value, `iniciativas/${ini.id}/hitos/${idx}`));
  }
  for (const op of spec.onePager ?? []) visit(op.value, `onePager/${op.id}`);

  // aviso barato: si una misma clave la usan entidades de distinto tipo (krs vs
  // kpis vs onePager...), puede haber un conflicto de convención de escala/unidad
  // como el de RETURN_RATE_QTY (KRs en entero, KPIs en fracción 0-1) — ver CLAUDE.md.
  for (const ref of refs.values()) {
    const tipos = new Set(ref.usedBy.map(u => u.split("/")[0]));
    if (tipos.size > 1) {
      ref.warning = `usado por ${[...tipos].join(" y ")} — revisar convención de escala/unidad antes de aplicar el mismo número a ambos.`;
    }
  }
  return [...refs.values()];
}

async function list(): Promise<void> {
  const spec = JSON.parse(await readFile(SPEC_PATH, "utf8"));
  console.log(JSON.stringify(collectMetricRefs(spec), null, 2));
}

async function apply(valuesFile: string): Promise<void> {
  if (!valuesFile) throw new Error("uso: apply <values.json>");
  const resolved = JSON.parse(await readFile(valuesFile, "utf8")) as Record<string, unknown>;
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "number") throw new Error(`valor no numérico para "${key}": ${JSON.stringify(value)}`);
    snapshot.values[key] = value;
  }
  snapshot.fetched_at = new Date().toISOString();
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`${SNAPSHOT_PATH}: actualizadas ${Object.keys(resolved).length} clave(s).`);
}

const [, , cmd, arg] = process.argv;
if (cmd === "list") list().catch(e => { console.error(e); process.exit(1); });
else if (cmd === "apply") apply(arg).catch(e => { console.error(e); process.exit(1); });
else {
  console.error('uso: node refresh-metrics.js list\n     node refresh-metrics.js apply <values.json>');
  process.exit(1);
}
